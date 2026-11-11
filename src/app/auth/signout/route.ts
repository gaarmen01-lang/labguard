/** POST /auth/signout — déconnexion puis retour à /login. */
import { NextResponse, type NextRequest } from 'next/server';

import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch (error) {
    console.error('[labguard] déconnexion :', error);
  }
  return NextResponse.redirect(new URL('/login', request.nextUrl.origin), 303);
}
