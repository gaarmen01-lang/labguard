/**
 * POST /api/admin/documents/[id]/ingest/step : avance le traitement d'un pas
 * borné dans le temps. Le client rappelle tant que `done` est faux.
 */
import { requireAdmin } from '@/lib/auth/session';
import type { IngestResponse } from '@/lib/contracts';
import { documentIdFrom, NO_STORE, type IdRouteContext } from '@/lib/ingestion/http';
import { runIngestionStep } from '@/lib/ingestion/pipeline';
import { getPipelineDeps, ingestionErrorResponse } from '@/lib/ingestion/server';

export const dynamic = 'force-dynamic';
// Le pas s'arrête de lui-même vers 45 s (DEFAULT_STEP_BUDGET_MS).
export const maxDuration = 60;

export async function POST(_request: Request, context: IdRouteContext) {
  try {
    await requireAdmin();
    const id = await documentIdFrom(context);
    const body: IngestResponse = await runIngestionStep(getPipelineDeps(), id);
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    return ingestionErrorResponse(error);
  }
}
