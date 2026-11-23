import Link from 'next/link';
import { qs } from '@/lib/admin/api';

/** Previous/next links that keep the other filters in the URL. */
export function Pager({ basePath, params, page, pageCount, total }: { basePath: string; params: Record<string, string | undefined>; page: number; pageCount: number; total: number }) {
  if (pageCount <= 1) return <p className="pt-3 text-sm text-muted-foreground">{total} result{total === 1 ? '' : 's'}</p>;
  const href = (p: number) => `${basePath}${qs({ ...params, page: p })}`;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between pt-4 text-sm">
      {page > 1 ? <Link className="font-medium underline" href={href(page - 1)}>Previous</Link> : <span />}
      <span className="text-muted-foreground">Page {page} of {pageCount} · {total} results</span>
      {page < pageCount ? <Link className="font-medium underline" href={href(page + 1)}>Next</Link> : <span />}
    </nav>
  );
}
