/**
 * GET    /api/admin/documents/[id]  détail (dernier job, fiches extraites, comptes)
 * PATCH  /api/admin/documents/[id]  métadonnées d'un brouillon
 * DELETE /api/admin/documents/[id]  suppression (brouillon ou archivé) + fichier
 */
import { parseOrThrow, readJson } from '@/lib/auth/errors';
import { requireAdmin } from '@/lib/auth/session';
import {
  updateDocumentRequestSchema,
  type DocumentDetailResponse,
  type DocumentStatusResponse,
} from '@/lib/contracts';
import { deleteDocument, getDocumentDetail, updateDocument } from '@/lib/ingestion/admin';
import { documentIdFrom, NO_STORE, type IdRouteContext } from '@/lib/ingestion/http';
import { getAdminDeps, ingestionErrorResponse } from '@/lib/ingestion/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: IdRouteContext) {
  try {
    await requireAdmin();
    const id = await documentIdFrom(context);
    const body: DocumentDetailResponse = await getDocumentDetail(getAdminDeps(), id);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: IdRouteContext) {
  try {
    await requireAdmin();
    const id = await documentIdFrom(context);
    const patch = parseOrThrow(updateDocumentRequestSchema, await readJson(request));
    const body: DocumentStatusResponse = await updateDocument(getAdminDeps(), id, patch);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: IdRouteContext) {
  try {
    await requireAdmin();
    const id = await documentIdFrom(context);
    const body: DocumentStatusResponse = await deleteDocument(getAdminDeps(), id);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
