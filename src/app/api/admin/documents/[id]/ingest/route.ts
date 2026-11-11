/**
 * GET  /api/admin/documents/[id]/ingest  état du dernier job
 * POST /api/admin/documents/[id]/ingest  lance (ou reprend) le traitement ;
 *                                        corps optionnel { restart?: boolean }
 */
import { parseOrThrow } from '@/lib/auth/errors';
import { requireAdmin } from '@/lib/auth/session';
import { ingestRequestSchema, type IngestResponse } from '@/lib/contracts';
import { documentIdFrom, NO_STORE, readOptionalJson, type IdRouteContext } from '@/lib/ingestion/http';
import { getIngestionState, startIngestion } from '@/lib/ingestion/pipeline';
import { getPipelineDeps, ingestionErrorResponse } from '@/lib/ingestion/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: IdRouteContext) {
  try {
    await requireAdmin();
    const id = await documentIdFrom(context);
    const body: IngestResponse = await getIngestionState(getPipelineDeps(), id);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}

export async function POST(request: Request, context: IdRouteContext) {
  try {
    const auth = await requireAdmin();
    const id = await documentIdFrom(context);
    const input = parseOrThrow(ingestRequestSchema, await readOptionalJson(request));
    const body: IngestResponse = await startIngestion(getPipelineDeps(), id, {
      restart: input.restart,
      userId: auth.userId,
    });
    return Response.json(body, { status: 202, headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
