import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/auth/admin";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { isValidBookingTime } from "@/lib/booking/hours";
import { calculateBookingPriceBreakdown, parseSelectedEquipmentQuantities } from "@/lib/booking/pricing";
import { validateAreaCapacity } from "@/lib/business-rules/areas";

const AREA_SLOT_CONFLICT_MESSAGE = "This area is already booked for this date and time. Please choose another area or time.";

const isTerminalPaymentStatus = (status: string | null | undefined) =>
  ["rejected", "cancelled", "failed", "refunded", "refund_failed"].includes(String(status ?? "").trim().toLowerCase());

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookingId: string }> },
) {
  try {
    await requireAdminAccess();
    const { bookingId } = await params;
    const formData = await request.formData();
    const bookingDate = String(formData.get("bookingDate") ?? "").trim();
    const bookingTime = String(formData.get("bookingTime") ?? "").trim();
    const areaId = String(formData.get("areaId") ?? "").trim();

    if (!bookingId || !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate) || !isValidBookingTime(bookingTime) || !areaId) {
      return NextResponse.json({ error: "A valid date, time, and area are required." }, { status: 400 });
    }

    const selectedDate = new Date(`${bookingDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (Number.isNaN(selectedDate.getTime()) || selectedDate < today) {
      return NextResponse.json({ error: "Booking date cannot be in the past." }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();
    const { data: existingBooking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select("id, booking_status, payment_status, adults, children_3_plus, children_under_3, selected_equipment_ids, selected_paid_activity_id, selected_tent_area_id, selected_photo_shoot_id")
      .eq("id", bookingId)
      .maybeSingle();

    if (bookingError) {
      return NextResponse.json({ error: bookingError.message }, { status: 500 });
    }

    if (!existingBooking) {
      return NextResponse.json({ error: "Booking not found." }, { status: 404 });
    }

    const bookingStatus = String(existingBooking.booking_status ?? "").trim().toLowerCase();
    if (!['pending', 'confirmed'].includes(bookingStatus) || isTerminalPaymentStatus(existingBooking.payment_status)) {
      return NextResponse.json({ error: "This booking cannot be rescheduled in its current status." }, { status: 409 });
    }

    const { data: area, error: areaError } = await supabaseAdmin
      .from("products")
      .select("id, name, price, capacity")
      .eq("id", areaId)
      .eq("category", "picnic_area")
      .eq("is_active", true)
      .eq("is_bookable", true)
      .maybeSingle();

    if (areaError || !area) {
      return NextResponse.json({ error: "The selected picnic area is unavailable." }, { status: 400 });
    }

    const adults = Number(existingBooking.adults ?? 0);
    const children3Plus = Number(existingBooking.children_3_plus ?? 0);
    const childrenUnder3 = Number(existingBooking.children_under_3 ?? 0);
    const capacityCheck = validateAreaCapacity(area.name, adults, children3Plus, childrenUnder3);
    if (!capacityCheck.valid) {
      return NextResponse.json({ error: capacityCheck.message || "The selected area cannot accommodate this booking." }, { status: 400 });
    }

    const productCapacity = Number(area.capacity ?? 0);
    if (Number.isFinite(productCapacity) && productCapacity > 0 && adults + children3Plus + childrenUnder3 > productCapacity) {
      return NextResponse.json({ error: "The selected area cannot accommodate this booking." }, { status: 400 });
    }

    const selectedEquipmentIds = Array.isArray(existingBooking.selected_equipment_ids)
      ? existingBooking.selected_equipment_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    const equipmentQuantities = parseSelectedEquipmentQuantities(selectedEquipmentIds);
    const selectedPaidActivityId = typeof existingBooking.selected_paid_activity_id === "string" ? existingBooking.selected_paid_activity_id : null;
    const selectedTentAreaId = typeof existingBooking.selected_tent_area_id === "string" ? existingBooking.selected_tent_area_id : null;
    const selectedPhotoShootId = typeof existingBooking.selected_photo_shoot_id === "string" ? existingBooking.selected_photo_shoot_id : null;
    const selectedProductIds = [...Object.keys(equipmentQuantities), selectedPaidActivityId, selectedTentAreaId, selectedPhotoShootId].filter((id): id is string => Boolean(id));
    const { data: products, error: productsError } = selectedProductIds.length
      ? await supabaseAdmin.from("products").select("*").in("id", [...new Set(selectedProductIds)]).eq("is_active", true).eq("is_bookable", true).in("category", ["equipment", "paid_activity", "tent_event_area", "photo_shoot"])
      : { data: [], error: null };

    if (productsError) {
      return NextResponse.json({ error: productsError.message }, { status: 500 });
    }

    const productMap = new Map((products ?? []).map((product) => [product.id, product]));
    if (selectedProductIds.some((id) => !productMap.has(id))) {
      return NextResponse.json({ error: "One or more booking products are no longer available." }, { status: 400 });
    }

    const finalBreakdown = calculateBookingPriceBreakdown({
      adults,
      children3Plus,
      childrenUnder3,
      selectedArea: area,
      equipmentQuantities,
      products: Array.from(productMap.values()) as any,
      selectedPaidActivityId,
      selectedTentAreaId,
      selectedPhotoShootId,
      bookingDate,
      creationDate: new Date().toISOString().split("T")[0],
    });

    const { data: conflicts, error: conflictError } = await supabaseAdmin
      .from("bookings")
      .select("id")
      .eq("selected_area_id", areaId)
      .eq("booking_date", bookingDate)
      .like("booking_time", `${bookingTime}%`)
      .neq("id", bookingId)
      .in("booking_status", ["pending", "confirmed"])
      .or("payment_status.is.null,payment_status.not.in.(rejected,cancelled,failed,refunded,refund_failed)");

    if (conflictError) {
      return NextResponse.json({ error: conflictError.message }, { status: 500 });
    }

    if ((conflicts ?? []).length > 0) {
      return NextResponse.json({ error: AREA_SLOT_CONFLICT_MESSAGE }, { status: 409 });
    }

    const { data, error } = await supabaseAdmin
      .from("bookings")
      .update({
        booking_date: bookingDate,
        booking_time: bookingTime,
        selected_area_id: areaId,
        entrance_fee_total: finalBreakdown.entranceFeeTotal,
        additional_total: finalBreakdown.additionalTotal,
        total_price: finalBreakdown.total,
        updated_at: new Date().toISOString(),
      })
      .eq("id", bookingId)
      .select("id, reservation_code, booking_date, booking_time, selected_area_id")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: AREA_SLOT_CONFLICT_MESSAGE }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, booking: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to reschedule booking." }, { status: 500 });
  }
}
