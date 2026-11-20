// 업로드 폰트 파일 같은 출처 중계 (v2.0 사용자 제보 — 「등록한 폰트가 적용이 안 돼요」).
//
// 서버 모드의 폰트 파일은 저장소(파이어베이스/수파베이스)의 공개 URL인데, **폰트는 브라우저가
// CORS를 강제하는 자원**이라(이미지와 다르다) 저장소가 허용 헤더를 안 주면 로드가 통째로
// 거부된다 — 등록은 되는데 화면은 조용히 폴백 글꼴로 남는 원인. 이 라우트가 서버에서 대신
// 받아 같은 출처로 내주면 CORS가 아예 걸리지 않는다.
//
// 아무 주소나 대신 받아 주는 통로가 되지 않게 저장소 호스트만 허용한다.
const ALLOWED = [
  /(^|\.)firebasestorage\.googleapis\.com$/,
  /(^|\.)supabase\.co$/,
  /(^|\.)supabase\.in$/,
];

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get('u') ?? '';
  let target: URL;
  try { target = new URL(u); } catch { return new Response('bad url', { status: 400 }); }
  // R2로 옮긴 경우 그 공개 주소 호스트도 허용 (/api/files)
  let r2Host = '';
  try { r2Host = process.env.R2_PUBLIC_URL ? new URL(process.env.R2_PUBLIC_URL).hostname : ''; } catch { /* 잘못된 값 — 무시 */ }
  if (target.protocol !== 'https:' || !(ALLOWED.some(r => r.test(target.hostname)) || (r2Host && target.hostname === r2Host))) {
    return new Response('host not allowed', { status: 400 });
  }
  try {
    const res = await fetch(target, { cache: 'no-store' });
    if (!res.ok || !res.body) return new Response('fetch failed', { status: 502 });
    return new Response(res.body, {
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
        // 파일 주소에 고유 id가 들어 있어 내용이 변할 일이 없다 — 오래 캐시
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('fetch failed', { status: 502 });
  }
}
