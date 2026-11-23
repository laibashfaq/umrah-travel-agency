import { proxyDocument } from '@/lib/file-proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyDocument((docId) => `/admin/documents/${docId}/file`, id);
}
