/**
 * POST /api/admin/documents/[id]/archive : archive le document (il n'est plus interrogeable).
 */
import { requireAdmin } from '@/lib/auth/session';
import type { DocumentStatusResponse } from '@/lib/contracts';
import { archiveDocument } from '@/lib/ingestion/admin';
import { documentIdFrom, NO_STORE, type IdRouteContext } from '@/lib/ingestion/http';
import { getAdminDeps, ingestionErrorResponse } from '@/lib/ingestion/server';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: IdRouteContext) {
  try {
    await requireAdmin();
    const id = await documentIdFrom(context);
    const body: DocumentStatusResponse = await archiveDocument(getAdminDeps(), id);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
