/**
 * GET  /api/admin/documents?status=…  liste des documents (admin)
 * POST /api/admin/documents           crée un document « draft » et renvoie une
 *                                     URL d'envoi signée vers le bucket privé
 */
import { parseOrThrow, readJson } from '@/lib/auth/errors';
import { requireAdmin } from '@/lib/auth/session';
import {
  createDocumentRequestSchema,
  documentListQuerySchema,
  type CreateDocumentResponse,
  type DocumentListResponse,
} from '@/lib/contracts';
import { createDocument, listDocuments } from '@/lib/ingestion/admin';
import { NO_STORE } from '@/lib/ingestion/http';
import { getAdminDeps, ingestionErrorResponse } from '@/lib/ingestion/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const query = parseOrThrow(documentListQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    const body: DocumentListResponse = await listDocuments(getAdminDeps(), query);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin();
    const input = parseOrThrow(createDocumentRequestSchema, await readJson(request));
    const body: CreateDocumentResponse = await createDocument(getAdminDeps(), input, auth.userId);
    return Response.json(body, { status: 201, headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
