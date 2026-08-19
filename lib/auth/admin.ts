import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export const ADMIN_SESSION_COOKIE = "booking_admin_session";

export function getSupabasePublicClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase URL or public key configuration for admin authentication.");
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function setAdminSessionCookie(email: string, accessToken: string) {
  const cookieStore = await cookies();
  const payload = {
    email: email.trim().toLowerCase(),
    accessToken,
    expiresAt: Date.now() + 1000 * 60 * 60 * 8,
  };

  cookieStore.set(ADMIN_SESSION_COOKIE, JSON.stringify(payload), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 8,
  });
}

export async function clearAdminSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_SESSION_COOKIE);
}

export async function getAdminSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;

  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as { email?: string; accessToken?: string; expiresAt?: number };
    if (!parsed.email || !parsed.accessToken || !parsed.expiresAt || parsed.expiresAt < Date.now()) {
      return null;
    }

    return {
      email: parsed.email,
      accessToken: parsed.accessToken,
    };
  } catch {
    return null;
  }
}

export async function requireAdminAccess() {
  const session = await getAdminSession();
  if (!session) {
    throw new Error("Admin session required.");
  }

  const supabase = getSupabasePublicClient();
  const { data, error } = await supabase.auth.getUser(session.accessToken);
  const verifiedEmail = data.user?.email?.trim().toLowerCase();

  if (error || !verifiedEmail || verifiedEmail !== session.email.trim().toLowerCase()) {
    throw new Error("Admin session is invalid or expired.");
  }

  const allowedEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.length > 0 && !allowedEmails.includes(session.email.toLowerCase())) {
    throw new Error("Access denied for this administrator account.");
  }

  return session;
}
