import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  env,
  isSupabaseServiceConfigured,
} from '../config/env.js';

let serviceClient: SupabaseClient | undefined;

export function getSupabaseServerClient(): SupabaseClient {
  if (!isSupabaseServiceConfigured) {
    throw new Error('Supabase service-role access is not configured');
  }

  serviceClient ??= createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return serviceClient;
}
