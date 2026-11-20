'use client';
// 환경설정 > 데이터 백업 — 이미지 저장소(Cloudflare R2) 구역 (Firebase Blaze 요금을 없애려는 사용자 요청)
// 연결 상태 · 사용량(무료 10GB 중 얼마) · 옛 저장소(Firebase/Supabase) 이미지를 R2로 옮기기.
// 서버 쪽은 /api/files, 파일 함수 교체는 lib/r2Files.
import { useEffect, useState } from 'react';
import { backend } from '@/lib/backend';
import type { ListItem } from '@/lib/backend';
import { r2Ready, r2Base, r2Call } from '@/lib/r2Files';
import { dumpAll, collectRefs, replaceRefs } from '@/lib/transfer';
import { isLocalOnlySetting } from '@/lib/settingStore';
import { useToast } from '@/components/ui/Toast';
import { ConfirmModal } from '@/components/ui/Modal';

const FREE = 10 * 1024 ** 3;   // R2 무료 저장량
const fmt = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)}GB` : `${(b / 1024 ** 2).toFixed(1)}MB`);

export function R2StorageRow() {
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ask, setAsk] = useState(false);
  const [guide, setGuide] = useState(false);

  const loadUsage = async () => {
    const be = backend();
    if (!be) return;
    try {
      const { files } = await r2Call<{ files: { key: string; size: number }[] }>(be, { op: 'list' });
      setUsage({ bytes: files.reduce((s, f) => s + f.size, 0), count: files.length });
    } catch (e) { setMsg(`사용량을 읽지 못했습니다 — ${(e as Error).message}`); }
  };
  useEffect(() => { void r2Ready().then(s => { setOn(s.enabled); if (s.enabled) void loadUsage(); }); }, []);

  /* 옛 저장소 → R2. 글·설정 안의 주소를 새 주소로 바꿔 저장한다.
     원본 파일은 지우지 않는다 — 확인한 뒤 Firebase/Supabase 콘솔에서 직접 비운다 */
  const migrate = async () => {
    const be = backend();
    if (!be) return;
    setBusy(true);
    try {
      setMsg('데이터 읽는 중…');
      const snap = await dumpAll(be);
      // 못 읽은 곳이 있으면 그 안의 주소를 못 바꾼다 — 옛 저장소를 비우면 거기 이미지가 깨진다
      if (snap.failed?.length) throw new Error(`${snap.failed.join(', ')}을(를) 읽지 못했습니다 — 잠시 뒤 다시 시도해 주세요`);
      const me = await be.currentUser();
      // 다른 회원의 프로필 사진 — 서버 규칙은 관리자 수정을 허용하지만 앱에 남의 프로필을 고치는 함수가 없다.
      // 옮겨도 주소를 못 바꿔 R2에 고아 파일만 생기므로 내 것만 (나머지는 가이드 4번 — 수동)
      const mine = (snap.members ?? []).filter(m => m.id === me?.id);
      const isR2 = (u: string) => u.startsWith(`${r2Base()}/`);
      const refs = [...collectRefs({ c: snap.collections, s: snap.settings, m: mine }, new Set())].filter(u => !isR2(u));
      const othersLeft = (snap.members ?? []).filter(m => m.id !== me?.id && m.avatarUrl && !isR2(m.avatarUrl)).length;
      if (!refs.length) {
        setMsg(`옮길 이미지가 없습니다${othersLeft ? ` — 다른 회원 프로필 사진 ${othersLeft}개는 아래 가이드 4번으로 옮겨 주세요` : ''}`);
        return;
      }

      const map = new Map<string, string>();
      let fail = 0;
      for (let i = 0; i < refs.length; i += 1) {
        setMsg(`이미지 옮기는 중 (${i + 1}/${refs.length})`);
        try { map.set(refs[i], (await r2Call<{ url: string }>(be, { op: 'copy', url: refs[i] })).url); }
        catch { fail += 1; }
      }

      setMsg('글 속 이미지 주소 바꾸는 중…');
      for (const [coll, list] of Object.entries(snap.collections)) {
        const next = replaceRefs(list, map);
        // 목록 전체를 넘겨야 순서(sort)가 그대로다 — 바뀐 항목만 실제로 저장된다
        if (JSON.stringify(next) !== JSON.stringify(list)) await be.syncList(coll, list, next as ListItem[], me?.id ?? null);
      }
      for (const [k, v] of Object.entries(snap.settings)) {
        if (v === undefined || v === null || isLocalOnlySetting(k)) continue;
        const next = replaceRefs(v, map);
        if (JSON.stringify(next) !== JSON.stringify(v)) await be.saveSetting(k, next);
      }
      const myAvatar = mine[0]?.avatarUrl && map.get(mine[0].avatarUrl);
      if (myAvatar) await be.updateProfile({ avatarUrl: myAvatar });

      setMsg(`완료 — ${map.size}개 옮김${fail ? ` · ${fail}개 실패(다시 누르면 남은 것만 옮깁니다)` : ''}`
        + `${othersLeft ? ` · 다른 회원 프로필 사진 ${othersLeft}개는 아래 가이드 4번으로 옮겨 주세요` : ''}`);
      toast('이미지를 R2로 옮겼습니다');
      void loadUsage();
    } catch (e) {
      setMsg(`멈췄습니다 — ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copyCors = async () => {
    const cors = [{
      AllowedOrigins: [window.location.origin],
      AllowedMethods: ['GET', 'PUT'],
      AllowedHeaders: ['content-type', 'cache-control'],
      MaxAgeSeconds: 3600,
    }];
    try { await navigator.clipboard.writeText(JSON.stringify(cors, null, 2)); toast('CORS 설정을 복사했습니다'); }
    catch { toast('복사하지 못했습니다'); }
  };

  const pct = usage ? Math.min(100, (usage.bytes / FREE) * 100) : 0;

  return (
    <>
      <div className="set-row" style={{ flexWrap: 'wrap' }}>
        <div className="l">
          <b>이미지 저장소 (Cloudflare R2)</b>
          <small>
            {on === null ? '확인 중…'
              : on ? `연결됨 ✓ — 새 이미지는 R2에 올라갑니다 · 무료 10GB`
              : '꺼짐 — 지금은 Firebase/Supabase 저장소를 씁니다. Vercel 환경변수 5개를 넣고 다시 배포하면 켜집니다'}
          </small>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {on && usage && (
            <span className="hint" title={`파일 ${usage.count}개`}>{fmt(usage.bytes)} / 10GB</span>
          )}
          {on ? (
            <button className="btn btn-ghost" style={{ padding: '9px 18px', opacity: busy ? 0.5 : 1 }}
              disabled={busy} onClick={() => setAsk(true)}>{busy ? '옮기는 중…' : '옛 저장소에서 옮기기'}</button>
          ) : on === false && (
            <button className="btn btn-ghost" style={{ padding: '9px 18px' }} onClick={() => void copyCors()}>CORS 복사</button>
          )}
        </div>
      </div>
      {on && usage && (
        <div style={{ height: 4, borderRadius: 2, background: 'var(--line)', margin: '-4px 0 10px', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: pct > 90 ? 'var(--accent, #e66)' : 'var(--ink)' }} />
        </div>
      )}
      {msg && <p className="hint" style={{ margin: '0 0 12px' }}>{msg}</p>}
      {/* 설치·이전 가이드 (사용자 요청 — 접어 두고 필요할 때 펼친다) */}
      <div style={{ margin: '0 0 14px' }}>
        <button className="btn btn-ghost" style={{ height: 30, padding: '0 12px', fontSize: 11 }}
          onClick={() => setGuide(g => !g)}>{guide ? '가이드 접기 ▴' : 'R2 설치·이전 가이드 ▾'}</button>
        {guide && (
          <div className="hint" style={{ marginTop: 10, lineHeight: 1.8 }}>
            <b>1. Cloudflare 준비 (10~15분)</b><br />
            ① Cloudflare 가입 → R2 켜기 (카드 등록 필요 — 10GB 안에서는 청구되지 않습니다)<br />
            ② R2 버킷 만들기 (예: <code>ohome-images</code>)<br />
            ③ 공개 접근 켜기 — 버킷 → Settings → Public access<br />
            {'　'}· 커스텀 도메인(추천): Cloudflare에 연결한 도메인이 있으면 <code>img.내도메인.com</code> 같은 주소<br />
            {'　'}· r2.dev 주소: 클릭 한 번이면 되지만 Cloudflare가 테스트용으로 안내하는 주소라 속도 제한이 있을 수 있습니다<br />
            ④ 버킷 → Settings → CORS Policy에 붙여넣기{' '}
            <button className="btn btn-ghost" style={{ height: 24, padding: '0 10px', fontSize: 10.5 }} onClick={() => void copyCors()}>CORS 복사</button>
            <br />
            ⑤ R2 → Manage API Tokens → 토큰 만들기 (권한: Object Read &amp; Write, 이 버킷만) — Access Key ID · Secret Access Key가 나옵니다 (Secret은 이때만 보입니다)<br />
            <br />
            <b>2. Vercel 환경변수 (5분)</b><br />
            Vercel → 프로젝트 → Settings → Environment Variables (웹푸시 키를 넣은 곳)<br />
            {'　'}<code>R2_ACCOUNT_ID</code> Cloudflare 계정 ID (R2 첫 화면 오른쪽)<br />
            {'　'}<code>R2_ACCESS_KEY_ID</code> · <code>R2_SECRET_ACCESS_KEY</code> ⑤에서 받은 값<br />
            {'　'}<code>R2_BUCKET</code> 버킷 이름<br />
            {'　'}<code>R2_PUBLIC_URL</code> ③의 공개 주소 (https://로 시작, 끝에 / 없이)<br />
            → Deployments → 최신 배포 ⋯ → Redeploy. 이 화면에 「연결됨 ✓」이 뜨면 새 이미지는 R2로 올라갑니다<br />
            <br />
            <b>3. 기존 이미지 옮기기</b><br />
            ① 먼저 아래 「백업 내보내기 → ↓ 회원까지」로 백업 받기<br />
            ② 사람이 적은 때 「옛 저장소에서 옮기기」 — 글·설정·내 프로필 사진의 이미지를 복사하고 주소를 바꿉니다 (원본은 지우지 않음)<br />
            ③ 실패한 것이 있으면 다시 누르면 남은 것만 옮깁니다 — 「옮길 이미지가 없습니다」가 나오면 끝<br />
            <br />
            <b>4. 다른 회원 프로필 사진 (수동)</b><br />
            서버 규칙상 관리자가 고칠 수 있지만 홈 화면에는 남의 프로필을 고치는 기능이 없어 콘솔에서 합니다.
            가장 쉬운 방법은 그 회원이 정보수정에서 사진을 다시 올리는 것입니다 (자동으로 R2에 올라감).<br />
            직접 옮길 때:<br />
            ① 지금 사진 주소 찾기 — Firebase: 콘솔 → Firestore → <code>profiles</code> → 그 회원 문서의 <code>avatarUrl</code> /
            Supabase: Table Editor → <code>profiles</code> → <code>avatar_url</code><br />
            ② 그 주소를 브라우저에 열어 이미지 저장<br />
            ③ Cloudflare → R2 → 버킷 → <code>ohome</code> 폴더 안에 업로드 (파일 이름은 영문·숫자로) — <code>ohome/</code> 안이어야 사용량·이미지 정리에 잡힙니다<br />
            ④ 새 주소 = <code>R2_PUBLIC_URL/ohome/파일이름</code> (예: <code>https://img.내도메인.com/ohome/member1.png</code>) — 브라우저로 열어 보이는지 확인<br />
            ⑤ ①의 칸을 새 주소로 고쳐 저장<br />
            <br />
            <b>5. Firebase 정리 (순서 꼭 지키기)</b><br />
            ① 사이트에서 이미지·프로필 사진이 잘 보이는지 확인 — 「옮기기」를 한 번 더 눌러 「옮길 이미지가 없습니다」 확인<br />
            ② Firebase 콘솔 → Storage 비우기<br />
            ③ 요금제를 Spark(무료)로 변경 — 먼저 내리면 아직 안 옮긴 이미지가 안 보일 수 있습니다<br />
            <br />
            <b>안 해도 되는 것</b> — Firebase 관리자 키 같은 추가 열쇠(로그인 확인은 웹푸시와 같은 방식), 회원 재가입(글·회원·설정은 그대로)
          </div>
        )}
      </div>
      <ConfirmModal open={ask} onClose={() => setAsk(false)}
        title="옛 저장소 이미지를 R2로 옮길까요?"
        body="글·설정에 쓰인 이미지를 R2로 복사하고 주소를 바꿉니다. 원본은 지우지 않습니다. 옮기는 동안 다른 사람이 글을 고치면 그 수정이 덮일 수 있으니 한가한 때 하고, 먼저 「백업 내보내기」를 받아 두세요."
        buttons={[
          { label: 'CANCEL', kind: 'ghost', onClick: () => setAsk(false) },
          { label: '옮기기', kind: 'accent', onClick: () => { setAsk(false); void migrate(); } },
        ]} />
    </>
  );
}
