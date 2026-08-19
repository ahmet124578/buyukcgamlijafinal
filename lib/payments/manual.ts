/**
 * Manual Payment System - Bank Transfer / EFT and Cash at Gate
 * This module provides utilities for manual payment processing
 */

import { calculateBookingPriceBreakdown, parseSelectedEquipmentQuantities } from "@/lib/booking/pricing";
import type { ProductRecord } from "@/lib/products/types";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export type PaymentStatus =
  | "pending"
  | "pending_payment"
  | "receipt_uploaded"
  | "under_review"
  | "verified"
  | "rejected"
  | "receipt_required"
  | "failed"
  | "cancelled"
  | "refund_pending"
  | "refunded"
  | "partially_refunded"
  | "refund_failed";

export type PaymentMethod = "bank_transfer" | "cash_at_gate";

export type PaymentReviewStatus =
  | "pending"
  | "receipt_uploaded"
  | "under_review"
  | "verified"
  | "rejected"
  | "receipt_required"
  | "manual_review"
  | "approved"
  | "resubmission_requested";

export type BookingPaymentSummary = {
  id: string;
  total_price: number | null;
  payment_status: string | null;
  booking_status: string | null;
  payment_method?: PaymentMethod | null;
  customer_name: string | null;
  email: string | null;
  phone_number: string | null;
  booking_date: string | null;
  booking_time: string | null;
  reservation_code: string | null;
  selected_area_id: string | null;
  selected_equipment_ids: string[] | null;
  selected_paid_activity_id: string | null;
  selected_tent_area_id: string | null;
  selected_photo_shoot_id: string | null;
  adults: number | null;
  children_3_plus: number | null;
  children_under_3: number | null;
  receipt_path?: string | null;
  receipt_uploaded_at?: string | null;
  payment_date?: string | null;
  transaction_reference?: string | null;
  verification_status?: string | null;
  review_note?: string | null;
  rejection_reason?: string | null;
  verified_by?: string | null;
  verified_at?: string | null;
};

export const BANK_TRANSFER_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
];

export function getBankTransferDetails() {
  return {
    bankName: process.env.BANK_NAME || "Absa",
    accountName: process.env.BANK_ACCOUNT_NAME || "Chamlija",
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || "0000000000",
    branchCode: process.env.BANK_BRANCH_CODE || "000000",
    swiftCode: process.env.BANK_SWIFT_CODE || "",
    iban: process.env.BANK_IBAN || "",
  };
}

export function normalizePaymentStatus(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "pending";

  const aliasMap: Record<string, string> = {
    paid: "verified",
    pending_payment: "pending_payment",
    pending: "pending",
    receipt_uploaded: "receipt_uploaded",
    under_review: "under_review",
    verified: "verified",
    rejected: "rejected",
    receipt_required: "receipt_required",
    failed: "failed",
    cancelled: "cancelled",
    refund_pending: "refund_pending",
    refunded: "refunded",
    partially_refunded: "partially_refunded",
    refund_failed: "refund_failed",
  };

  return aliasMap[normalized] ?? normalized;
}

export function isWithinThreeDays(bookingDate: string | null | undefined): boolean {
  if (!bookingDate) return false;

  const date = new Date(`${bookingDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const diffDays = (date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays < 3;
}

export function getBookingPaymentState(booking: { payment_status?: string | null; booking_status?: string | null; payment_method?: string | null }) {
  const normalizedStatus = normalizePaymentStatus(booking.payment_status);

  if (normalizedStatus === "under_review") {
    return { code: "under_review", label: "Payment Under Review" };
  }

  if (normalizedStatus === "verified" || booking.booking_status === "confirmed") {
    return { code: "verified", label: "Payment Verified" };
  }

  if (normalizedStatus === "rejected") {
    return { code: "rejected", label: "Payment Verification Failed" };
  }

  if (normalizedStatus === "receipt_required") {
    return { code: "receipt_required", label: "New Payment Receipt Required" };
  }

  if (normalizedStatus === "receipt_uploaded") {
    return { code: "receipt_uploaded", label: "Receipt uploaded successfully" };
  }

  if (booking.payment_method === "bank_transfer") {
    return { code: "payment_required", label: "Payment Required" };
  }

  return { code: "pending", label: "Payment Pending" };
}

export async function ensurePaymentReceiptBucket() {
  const supabaseAdmin = getSupabaseAdminClient();

  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) {
    throw new Error(listError.message);
  }

  if (buckets?.some((bucket) => bucket.name === "payment-receipts")) {
    return;
  }

  const { error: createError } = await supabaseAdmin.storage.createBucket("payment-receipts", {
    public: false,
    fileSizeLimit: 4 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "application/pdf"],
  });

  if (createError && !/already exists/i.test(createError.message)) {
    throw new Error(createError.message);
  }
}

export async function getPrivateReceiptUrl(storagePath: string, expiresInSeconds = 3600) {
  const supabaseAdmin = getSupabaseAdminClient();
  const { data, error } = await supabaseAdmin.storage.from("payment-receipts").createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    return null;
  }

  return data.signedUrl;
}

export async function getBookingPaymentSummary(bookingId: string): Promise<BookingPaymentSummary | null> {
  const supabaseAdmin = getSupabaseAdminClient();

  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select(
      "id, total_price, booking_status, payment_status, payment_method, customer_name, email, phone_number, booking_date, booking_time, reservation_code, selected_area_id, selected_equipment_ids, selected_paid_activity_id, selected_tent_area_id, selected_photo_shoot_id, adults, children_3_plus, children_under_3, created_at",
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const selectedAreaId = typeof data.selected_area_id === "string" ? data.selected_area_id : null;
  const selectedEquipmentIds = Array.isArray(data.selected_equipment_ids) ? data.selected_equipment_ids.filter((value): value is string => typeof value === "string") : [];
  const selectedPaidActivityId = typeof data.selected_paid_activity_id === "string" ? data.selected_paid_activity_id : null;
  const selectedTentAreaId = typeof data.selected_tent_area_id === "string" ? data.selected_tent_area_id : null;
  const selectedPhotoShootId = typeof data.selected_photo_shoot_id === "string" ? data.selected_photo_shoot_id : null;

  let selectedArea = null;
  if (selectedAreaId) {
    const { data: areaData } = await supabaseAdmin.from("products").select("*").eq("id", selectedAreaId).maybeSingle();
    if (areaData) {
      selectedArea = areaData;
    }
  }

  const productIds = [...new Set(
    [
      ...Object.keys(parseSelectedEquipmentQuantities(selectedEquipmentIds)),
      selectedPaidActivityId,
      selectedTentAreaId,
      selectedPhotoShootId,
    ].filter((value): value is string => Boolean(value)),
  )];

  let products: ProductRecord[] = [];

  if (productIds.length > 0) {
    const { data: productRows } = await supabaseAdmin
      .from("products")
      .select("id, name, price, category, currency, is_active, is_bookable, is_free, description, capacity, size, entry_fee_excluded, image_url, item_order")
      .in("id", productIds)
      .eq("is_active", true)
      .eq("is_bookable", true);

    if (productRows) {
      products = (productRows as unknown as ProductRecord[]);
    }
  }

  const adults = Number(data.adults ?? 0);
  const children3Plus = Number(data.children_3_plus ?? 0);
  const childrenUnder3 = Number(data.children_under_3 ?? 0);
  
  // Extract creation date for discount calculation
  const creationDate = data.created_at ? new Date(data.created_at).toISOString().split("T")[0] : undefined;
  
  const breakdown = calculateBookingPriceBreakdown({
    adults,
    children3Plus,
    childrenUnder3,
    selectedArea,
    equipmentQuantities: parseSelectedEquipmentQuantities(selectedEquipmentIds),
    products,
    selectedPaidActivityId,
    selectedTentAreaId,
    selectedPhotoShootId,
    bookingDate: data.booking_date,
    creationDate,
  });

  const canonicalTotal = breakdown.total;
  const storedTotal = Number(data.total_price ?? 0);

  if (storedTotal !== canonicalTotal) {
    await supabaseAdmin.from("bookings").update({ total_price: canonicalTotal }).eq("id", bookingId);
  }

  const { data: paymentData } = await supabaseAdmin
    .from("payments")
    .select("id, receipt_path, receipt_uploaded_at, payment_date, transaction_reference, verification_status, rejection_reason, admin_notes, verified_by, verified_at, review_note, status")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    ...data,
    payment_method: data.payment_method,
    selected_equipment_ids: selectedEquipmentIds,
    selected_paid_activity_id: selectedPaidActivityId,
    selected_tent_area_id: selectedTentAreaId,
    selected_photo_shoot_id: selectedPhotoShootId,
    adults,
    children_3_plus: children3Plus,
    children_under_3: childrenUnder3,
    total_price: canonicalTotal,
    reservation_code: data.reservation_code,
    receipt_path: paymentData?.receipt_path ?? null,
    receipt_uploaded_at: paymentData?.receipt_uploaded_at ?? null,
    payment_date: paymentData?.payment_date ?? null,
    transaction_reference: paymentData?.transaction_reference ?? null,
    verification_status: paymentData?.verification_status ?? null,
    review_note: paymentData?.review_note ?? null,
    rejection_reason: paymentData?.rejection_reason ?? null,
    verified_by: paymentData?.verified_by ?? null,
    verified_at: paymentData?.verified_at ?? null,
  } as BookingPaymentSummary;
}

export function formatCurrency(value: number | null | undefined): string {
  const numeric = Number(value ?? 0);
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    maximumFractionDigits: 0,
  }).format(numeric);
}
