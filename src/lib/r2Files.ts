'use client';
// 이미지 저장소를 Cloudflare R2로 돌리는 연결부 — 서버 쪽은 /api/files 라우트.
//
// 백엔드의 파일 함수 3개(uploadFile·listFiles·deleteFile)만 갈아 끼운다. 글·회원·설정은 그대로
// Firebase/Supabase에 있다. R2 환경변수가 없으면 아무것도 바꾸지 않는다(지금처럼 동작).
// 옛 저장소에 남은 파일도 목록·삭제가 되게 원래 함수를 함께 쓴다 (옮기기 전·옮기는 중에도 정리가 맞게).
import type { Backend } from './backend/types';

type Status = { enabled: boolean; publicUrl?: string };

let base = '';                                  // R2 공개 주소 (켜졌을 때만)
let ready: Promise<Status> | null = null;

/** R2 공개 주소 — 꺼져 있으면 '' */
export const r2Base = () => base;

/** R2 사용 여부 확인 — 앱 시작을 늦추지 않게 기다리지 않고 시작해 두고, 파일을 다룰 때 기다린다 */
export function r2Ready(): Promise<Status> {
  if (!ready) {
    ready = fetch('/api/files', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() as Promise<Status> : { enabled: false }))
      .catch((): Status => ({ enabled: false }))
      .then((s: Status) => { base = s.enabled && s.publicUrl ? s.publicUrl : ''; return s; });
  }
  return ready;
}

/** /api/files 호출 (로그인 토큰을 붙여서) */
export async function r2Call<T>(be: Backend, body: Record<string, unknown>): Promise<T> {
  const token = await be.authToken();
  const r = await fetch('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(j.error === 'forbidden' ? '관리자만 할 수 있습니다' : j.error || `요청 실패 (${r.status})`);
  return j;
}

/** 백엔드를 만든 직후 1회 — 파일 함수만 R2 쪽으로 감싼다 */
export function attachR2(be: Backend): void {
  void r2Ready();
  const orig = { upload: be.uploadFile, list: be.listFiles, del: be.deleteFile };

  be.uploadFile = async (blob, ext) => {
    if (!(await r2Ready()).enabled) return orig.upload(blob, ext);
    const s = await r2Call<{ put: string; url: string; cacheControl: string }>(be, { op: 'sign', ext });
    const r = await fetch(s.put, {
      method: 'PUT', body: blob,
      headers: { 'Content-Type': blob.type || 'application/octet-stream', 'Cache-Control': s.cacheControl },
    });
    if (!r.ok) throw new Error(`이미지 업로드 실패 (R2 ${r.status})`);
    return s.url;
  };

  be.listFiles = async () => {
    if (!(await r2Ready()).enabled) return orig.list();
    const { files } = await r2Call<{ files: { key: string; size: number }[] }>(be, { op: 'list' });
    // 옛 저장소는 못 읽어도 된다(Storage를 비우고 무료 요금제로 내린 뒤) — 목록이 빠지면 덜 지울 뿐 더 지우지는 않는다
    let old: { ref: string; size: number }[] = [];
    try { old = await orig.list(); } catch { /* 무시 */ }
    return [...files.map(f => ({ ref: `${base}/${f.key}`, size: f.size })), ...old];
  };

  be.deleteFile = async (ref) => {
    if ((await r2Ready()).enabled && ref.startsWith(`${base}/`)) {
      await r2Call(be, { op: 'delete', url: ref });
      return;
    }
    return orig.del(ref);
  };
}
