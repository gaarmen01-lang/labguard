/**
 * GET /api/admin/documents/[id]/file : URL signée de courte durée vers le
 * fichier original (bucket privé).
 */
import { requireAdmin } from '@/lib/auth/session';
import type { DocumentFileUrlResponse } from '@/lib/contracts';
import { getDocumentFileUrl } from '@/lib/ingestion/admin';
import { documentIdFrom, NO_STORE, type IdRouteContext } from '@/lib/ingestion/http';
import { getAdminDeps, ingestionErrorResponse } from '@/lib/ingestion/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: IdRouteContext) {
  try {
    await requireAdmin();
    const id = await documentIdFrom(context);
    const body: DocumentFileUrlResponse = await getDocumentFileUrl(getAdminDeps(), id);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
