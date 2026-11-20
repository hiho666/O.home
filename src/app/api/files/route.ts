// 이미지 저장소 — Cloudflare R2 (Firebase Blaze 요금 없이 이미지를 두는 곳)
//
// R2 열쇠는 브라우저에 둘 수 없으므로 Vercel 환경변수에 두고 이 라우트가 서명해 준다.
// 브라우저는 서명된 주소로 R2에 직접 올린다 (파일이 Vercel을 거치지 않는다).
// 환경변수 5개가 다 있어야 켜진다 — 하나라도 없으면 지금처럼 Firebase/Supabase 저장소를 쓴다.
//   R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET · R2_PUBLIC_URL(공개 주소, 끝 / 없이)
//
//  GET  /api/files                       → { enabled, publicUrl }
//  POST /api/files { op: 'sign', ext }   → { put, url }      로그인 회원 — 올릴 주소 발급
//  POST /api/files { op: 'list' }        → { files }          관리자 — 사용량·이미지 정리
//  POST /api/files { op: 'delete', url } → { ok }             관리자 — 이미지 정리
//  POST /api/files { op: 'copy', url }   → { url }            관리자 — 옛 저장소 파일을 R2로 복사 (서버끼리라 CORS 무관)
//
// SDK 없이 S3 서명(SigV4)을 직접 만든다 — 패키지를 늘리지 않으려고.
import { NextRequest, NextResponse } from 'next/server';
import { createHash, createHmac } from 'node:crypto';
import { serverSideConfig } from '@/lib/siteMeta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// 경로가 업로드마다 고유하므로 길게 캐시한다 (Firebase 업로드와 같은 값)
const CACHE = 'public, max-age=31536000, immutable';
const COPY_MAX = 50 * 1024 * 1024;

type Env = { account: string; keyId: string; secret: string; bucket: string; publicUrl: string };

function r2Env(): Env | null {
  const e = {
    account: (process.env.R2_ACCOUNT_ID ?? '').trim(),
    keyId: (process.env.R2_ACCESS_KEY_ID ?? '').trim(),
    secret: (process.env.R2_SECRET_ACCESS_KEY ?? '').trim(),
    bucket: (process.env.R2_BUCKET ?? '').trim(),
    publicUrl: (process.env.R2_PUBLIC_URL ?? '').trim().replace(/\/+$/, ''),
  };
  return Object.values(e).every(Boolean) && /^https:\/\//.test(e.publicUrl) ? e : null;
}

/* ---------- S3 서명 (SigV4) ---------- */

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();

/**
 * R2 요청 서명. expires가 있으면 주소에 서명을 담는다(브라우저가 직접 쓰는 업로드 주소),
 * 없으면 Authorization 헤더로 서명한다(이 서버가 바로 보내는 요청).
 * signHeaders: 함께 서명할 헤더 — 업로드 주소는 Cache-Control까지 묶어 브라우저가 그대로 보내게 한다.
 */
function signR2(env: Env, method: string, key: string, query: Record<string, string>,
  opt: { expires?: number; signHeaders?: Record<string, string> } = {}): { url: string; headers: Record<string, string> } {
  const host = `${env.account}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const path = '/' + [env.bucket, ...key.split('/').filter(Boolean)].map(enc).join('/');
  const payload = 'UNSIGNED-PAYLOAD';

  const headers: Record<string, string> = { host, ...(opt.signHeaders ?? {}) };
  const q: Record<string, string> = { ...query };
  if (!opt.expires) {
    headers['x-amz-date'] = amzDate;
    headers['x-amz-content-sha256'] = payload;
  }
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const signed = names.join(';');
  if (opt.expires) {
    Object.assign(q, {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${env.keyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(opt.expires),
      'X-Amz-SignedHeaders': signed,
    });
  }
  const qs = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&');
  const canon = [method, path, qs, names.map(n => `${n}:${lower[n]}\n`).join(''), signed, payload].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canon).digest('hex')].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${env.secret}`, day), 'auto'), 's3'), 'aws4_request');
  const sig = createHmac('sha256', kSign).update(sts).digest('hex');

  const base = `https://${host}${path}`;
  if (opt.expires) return { url: `${base}?${qs}&X-Amz-Signature=${sig}`, headers: {} };
  const { host: _h, ...rest } = lower;
  return {
    url: qs ? `${base}?${qs}` : base,
    headers: { ...rest, Authorization: `AWS4-HMAC-SHA256 Credential=${env.keyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}` },
  };
}

/* ---------- 호출한 사람 확인 ---------- */

/** 토큰의 주인 id — /api/push의 verifyCaller와 같은 방식(각 서비스의 공개 API, 관리자 키 없이) */
async function callerId(token: string): Promise<string | null> {
  const cfg = await serverSideConfig();
  if (!cfg || !token) return null;
  try {
    if (cfg.kind === 'supabase') {
      const r = await fetch(`${cfg.url}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey }, cache: 'no-store',
      });
      if (!r.ok) return null;
      return ((await r.json()) as { id?: string }).id ?? null;
    }
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }), cache: 'no-store',
    });
    if (!r.ok) return null;
    return ((await r.json()) as { users?: { localId?: string }[] }).users?.[0]?.localId ?? null;
  } catch { return null; }
}

/** 관리자인지 — Firebase는 meta/owner(공개 읽기), Supabase는 profiles.role (각 홈의 관리자 판정과 같은 곳) */
async function isAdmin(uid: string, token: string): Promise<boolean> {
  const cfg = await serverSideConfig();
  if (!cfg) return false;
  try {
    if (cfg.kind === 'supabase') {
      const r = await fetch(`${cfg.url}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, {
        headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey }, cache: 'no-store',
      });
      if (!r.ok) return false;
      return ((await r.json()) as { role?: string }[])[0]?.role === 'admin';
    }
    const db = encodeURIComponent(cfg.databaseId || '(default)');
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/${db}/documents/meta/owner?key=${encodeURIComponent(cfg.apiKey)}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const f = ((await r.json()) as { fields?: Record<string, { stringValue?: string; arrayValue?: { values?: { stringValue?: string }[] } }> }).fields ?? {};
    return f.uid?.stringValue === uid || (f.admins?.arrayValue?.values ?? []).some(v => v.stringValue === uid);
  } catch { return false; }
}

/* ---------- R2 작업 ---------- */

const newKey = (ext: string) => `ohome/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
const safeExt = (s: unknown) => (typeof s === 'string' && /^[a-z0-9]{1,5}$/i.test(s) ? s.toLowerCase() : 'bin');

/** 공개 주소 → 저장 키 (이 저장소의 ohome/ 아래 것만) */
function keyOf(env: Env, url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(`${env.publicUrl}/ohome/`)) return null;
  const key = decodeURIComponent(url.slice(env.publicUrl.length + 1).split(/[?#]/)[0]);
  return /^ohome\/[A-Za-z0-9._-]+$/.test(key) ? key : null;
}

async function listAll(env: Env): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token = '';
  for (let i = 0; i < 200; i += 1) {   // 1000개씩 — 20만 개에서 멈춘다(무한 반복 방지)
    const q: Record<string, string> = { 'list-type': '2', prefix: 'ohome/', 'max-keys': '1000' };
    if (token) q['continuation-token'] = token;
    const s = signR2(env, 'GET', '', q);
    const r = await fetch(s.url, { headers: s.headers, cache: 'no-store' });
    if (!r.ok) throw new Error(`R2 목록 실패 (${r.status})`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = m[1].match(/<Key>([^<]*)<\/Key>/)?.[1];
      const size = Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
      if (key) out.push({ key, size });
    }
    token = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1] ?? '';
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !token) break;
  }
  return out;
}

/** 옛 저장소 주소인지 — 복사는 Firebase/Supabase 저장소 파일만 받는다 (아무 주소나 받아 오는 통로가 되지 않게) */
function isOldStorage(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'firebasestorage.googleapis.com'
      || (u.hostname.endsWith('.supabase.co') && u.pathname.startsWith('/storage/v1/object/public/')));
  } catch { return false; }
}

async function copyIn(env: Env, url: string): Promise<string> {
  const src = await fetch(url, { cache: 'no-store' });
  if (!src.ok) throw new Error(`원본을 받지 못했습니다 (${src.status})`);
  const body = Buffer.from(await src.arrayBuffer());
  if (body.length > COPY_MAX) throw new Error('파일이 너무 큽니다');
  const type = src.headers.get('content-type') || 'application/octet-stream';
  const ext = safeExt(url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i)?.[1]
    ?? (type.includes('png') ? 'png' : type.includes('gif') ? 'gif' : type.includes('webp') ? 'webp' : type.includes('jpeg') ? 'jpg' : 'bin'));
  const key = newKey(ext);
  const s = signR2(env, 'PUT', key, {}, { signHeaders: { 'content-type': type, 'cache-control': CACHE } });
  const r = await fetch(s.url, { method: 'PUT', headers: s.headers, body, cache: 'no-store' });
  if (!r.ok) throw new Error(`R2 저장 실패 (${r.status})`);
  return `${env.publicUrl}/${key}`;
}

/* ---------- 라우트 ---------- */

export async function GET() {
  const env = r2Env();
  return NextResponse.json(env ? { enabled: true, publicUrl: env.publicUrl } : { enabled: false }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const env = r2Env();
  if (!env) return NextResponse.json({ error: 'not-configured' }, { status: 503, headers: NO_STORE });
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const uid = await callerId(token);
  if (!uid) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

  let body: { op?: string; ext?: unknown; url?: unknown } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad-json' }, { status: 400, headers: NO_STORE }); }

  try {
    if (body.op === 'sign') {
      const key = newKey(safeExt(body.ext));
      // 10분짜리 업로드 주소 — 브라우저는 Content-Type과 이 Cache-Control을 그대로 보내야 한다
      const s = signR2(env, 'PUT', key, {}, { expires: 600, signHeaders: { 'cache-control': CACHE } });
      return NextResponse.json({ put: s.url, url: `${env.publicUrl}/${key}`, cacheControl: CACHE }, { headers: NO_STORE });
    }

    // 나머지는 관리자만 — 목록·삭제·복사
    if (!(await isAdmin(uid, token))) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });

    if (body.op === 'list') {
      return NextResponse.json({ files: await listAll(env) }, { headers: NO_STORE });
    }
    if (body.op === 'delete') {
      const key = keyOf(env, body.url);
      if (!key) return NextResponse.json({ error: 'bad-url' }, { status: 400, headers: NO_STORE });
      const s = signR2(env, 'DELETE', key, {});
      const r = await fetch(s.url, { method: 'DELETE', headers: s.headers, cache: 'no-store' });
      if (!r.ok && r.status !== 404) throw new Error(`R2 삭제 실패 (${r.status})`);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    if (body.op === 'copy') {
      if (!isOldStorage(body.url)) return NextResponse.json({ error: 'bad-url' }, { status: 400, headers: NO_STORE });
      return NextResponse.json({ url: await copyIn(env, body.url) }, { headers: NO_STORE });
    }
    return NextResponse.json({ error: 'bad-op' }, { status: 400, headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502, headers: NO_STORE });
  }
}
