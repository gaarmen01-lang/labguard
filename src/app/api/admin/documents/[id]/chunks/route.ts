/**
 * GET /api/admin/documents/[id]/chunks?page=&offset=&limit= : aperçu paginé
 * des chunks (contrôle humain avant activation).
 */
import { parseOrThrow } from '@/lib/auth/errors';
import { requireAdmin } from '@/lib/auth/session';
import { documentChunksQuerySchema, type DocumentChunksResponse } from '@/lib/contracts';
import { listDocumentChunks } from '@/lib/ingestion/admin';
import { documentIdFrom, NO_STORE, type IdRouteContext } from '@/lib/ingestion/http';
import { getAdminDeps, ingestionErrorResponse } from '@/lib/ingestion/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: IdRouteContext) {
  try {
    await requireAdmin();
    const id = await documentIdFrom(context);
    const query = parseOrThrow(documentChunksQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    const body: DocumentChunksResponse = await listDocumentChunks(getAdminDeps(), id, query);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
