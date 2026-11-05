'use client';
/**
 * 옛 주소 유지 — 2차 CP 자랑존(구 TRPG 캐릭터) 주소를 `/tchars` → `/otaku`로 바꾸면서,
 * 예전에 공유했거나 즐겨찾기해 둔 주소가 죽지 않도록 그대로 넘겨 준다. 상세 주소(`/tchars/id`)와
 * 쿼리까지 함께 옮긴다. **저장 키(`ohome.tchars.v1`)와 테이블 이름(`trpg_chars`)은 건드리지 않는다** —
 * 주소와 무관하고, 바꾸면 기존 데이터가 통째로 사라진다.
 */
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function TcharsMoved() {
  const router = useRouter();
  const { slug } = useParams<{ slug?: string[] }>();
  useEffect(() => {
    const rest = Array.isArray(slug) && slug.length ? `/${slug.join('/')}` : '';
    router.replace(`/otaku${rest}${window.location.search}`);
  }, [router, slug]);
  return <section className="page" />;
}
