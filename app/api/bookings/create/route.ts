import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { isValidBookingTime } from "@/lib/booking/hours";
import { calculateBookingPriceBreakdown, parseSelectedEquipmentQuantities } from "@/lib/booking/pricing";
import { validateAreaCapacity, getAreaCapacity } from "@/lib/business-rules/areas";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { setBookingAccessCookie } from "@/lib/auth/booking-access";

const AREA_SLOT_CONFLICT_MESSAGE = "This area is already booked for this date and time. Please choose another area or time.";

function parseNonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const fullName = String(body.full_name ?? "").trim();
    const phoneNumber = String(body.phone_number ?? "").trim();
    const email = String(body.email ?? "").trim();
    const bookingDate = String(body.booking_date ?? "").trim();
    const bookingTime = String(body.booking_time ?? "").trim();
    const areaId = String(body.picnic_area_id ?? "").trim();
    const customerNotes = String(body.customer_notes ?? "").trim();
    const adults = parseNonNegativeInteger(body.adults);
    const children3Plus = parseNonNegativeInteger(body.children_3_plus);
    const childrenUnder3 = parseNonNegativeInteger(body.children_under_3);

    const selectedEquipmentIds = Array.isArray(body.selected_equipment_ids)
      ? body.selected_equipment_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];

    const equipmentQuantities = parseSelectedEquipmentQuantities(selectedEquipmentIds);

    const selectedPaidActivityId = typeof body.selected_paid_activity_id === "string" ? body.selected_paid_activity_id.trim() : null;
    const selectedTentAreaId = typeof body.selected_tent_area_id === "string" ? body.selected_tent_area_id.trim() : null;
    const selectedPhotoShootId = typeof body.selected_photo_shoot_id === "string" ? body.selected_photo_shoot_id.trim() : null;

    if (!fullName || !phoneNumber || !email || !bookingDate || !bookingTime) {
      return NextResponse.json({ error: "All required booking fields must be provided." }, { status: 400 });
    }

    if (adults < 0 || children3Plus < 0 || childrenUnder3 < 0) {
      return NextResponse.json({ error: "Guest counts cannot be negative." }, { status: 400 });
    }

    if (adults + children3Plus + childrenUnder3 <= 0) {
      return NextResponse.json({ error: "At least one guest must be present." }, { status: 400 });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
      return NextResponse.json({ error: "Please provide a valid booking date." }, { status: 400 });
    }

    if (!isValidBookingTime(bookingTime)) {
      return NextResponse.json({ error: "Please choose a valid booking time between 09:00 and 18:00." }, { status: 400 });
    }

    const selectedDate = new Date(`${bookingDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (Number.isNaN(selectedDate.getTime()) || selectedDate < today) {
      return NextResponse.json({ error: "Booking date cannot be in the past." }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();

    let area: { id: string; name: string; price?: number | null; capacity?: number | null } | null = null;

    if (areaId) {
      const { data: areaRecord, error: areaError } = await supabaseAdmin
        .from("products")
        .select("*")
        .eq("id", areaId)
        .eq("category", "picnic_area")
        .eq("is_active", true)
        .eq("is_bookable", true)
        .maybeSingle();

      if (areaError) {
        return NextResponse.json({ error: areaError.message }, { status: 500 });
      }

      if (!areaRecord) {
        return NextResponse.json({ error: "The selected picnic area is unavailable." }, { status: 400 });
      }

      const selectedArea = areaRecord as {
        id: string;
        name: string;
        price?: number | null;
        capacity?: number | null;
      };
      area = selectedArea;

      // Use centralized capacity validation
      const capacityCheck = validateAreaCapacity(selectedArea.name, adults, children3Plus, childrenUnder3);
      if (!capacityCheck.valid) {
        return NextResponse.json({ error: capacityCheck.message || "The selected area cannot accommodate your party size." }, { status: 400 });
      }
    }

    const selectedProductIds = [
      ...Object.keys(equipmentQuantities),
      selectedPaidActivityId,
      selectedTentAreaId,
      selectedPhotoShootId,
    ].filter((id): id is string => typeof id === "string" && Boolean(id.trim()));

    const productIds = [...new Set(selectedProductIds)];
    const validatedProductIds: string[] = [];

    let products: Array<{ id: string; price: number | null; category: string | null; is_free?: boolean | null; is_active?: boolean | null; is_bookable?: boolean | null }> = [];

    if (productIds.length > 0) {
      const { data: fetchedProducts, error: productsError } = await supabaseAdmin
        .from("products")
        .select("*")
        .in("id", productIds)
        .eq("is_active", true)
        .eq("is_bookable", true)
        .in("category", ["equipment", "paid_activity", "tent_event_area", "photo_shoot"]);

      if (productsError) {
        return NextResponse.json({ error: productsError.message }, { status: 500 });
      }

      products = fetchedProducts ?? [];
    }

    const productMap = new Map(products.map((product) => [product.id, product]));

    for (const [equipmentId, qty] of Object.entries(equipmentQuantities)) {
      const product = productMap.get(equipmentId);
      if (!product) {
        return NextResponse.json({ error: "One or more selected products are invalid or unavailable." }, { status: 400 });
      }
      if (product.is_free === true || product.category !== "equipment") {
        continue;
      }
      validatedProductIds.push(equipmentId);
    }

    for (const productId of [selectedPaidActivityId, selectedTentAreaId, selectedPhotoShootId]) {
      if (!productId) continue;

      const product = productMap.get(productId);
      if (!product) {
        return NextResponse.json({ error: "One or more selected products are invalid or unavailable." }, { status: 400 });
      }
      if (product.is_free === true) {
        continue;
      }
      if (product.category !== "paid_activity" && product.category !== "tent_event_area" && product.category !== "photo_shoot") {
        return NextResponse.json({ error: "One or more selected products belong to an invalid category." }, { status: 400 });
      }
      validatedProductIds.push(productId);
    }

    const finalBreakdown = calculateBookingPriceBreakdown({
      adults,
      children3Plus,
      childrenUnder3,
      selectedArea: area,
      equipmentQuantities,
      products: productMap.size > 0 ? Array.from(productMap.values()) as any : [],
      selectedPaidActivityId,
      selectedTentAreaId,
      selectedPhotoShootId,
      bookingDate,
      creationDate: new Date().toISOString().split("T")[0],
    });

    const finalTotal = finalBreakdown.total;

    if (areaId) {
      const { data: conflictingBookings, error: conflictError } = await supabaseAdmin
        .from("bookings")
        .select("id")
        .eq("selected_area_id", areaId)
        .eq("booking_date", bookingDate)
        .eq("booking_time", bookingTime)
        .in("booking_status", ["pending", "confirmed"])
        .or("payment_status.is.null,payment_status.not.in.(rejected,cancelled,failed,refunded,refund_failed)");

      if (conflictError) {
        return NextResponse.json({ error: conflictError.message }, { status: 500 });
      }

      if ((conflictingBookings ?? []).length > 0) {
        return NextResponse.json({ error: AREA_SLOT_CONFLICT_MESSAGE }, { status: 409 });
      }
    }

    const { data: productCapacityRows, error: capacityError } = await supabaseAdmin
      .from("products")
      .select("id, capacity, category")
      .in("id", areaId ? [areaId, ...validatedProductIds] : validatedProductIds);

    if (capacityError) {
      return NextResponse.json({ error: capacityError.message }, { status: 500 });
    }

    const productCapacityMap = new Map((productCapacityRows ?? []).map((row) => [row.id, row]));

    for (const productId of areaId ? [areaId, ...validatedProductIds] : validatedProductIds) {
      const capProduct = productCapacityMap.get(productId);
      if (!capProduct) continue;

      if (capProduct.capacity !== null && capProduct.capacity !== undefined) {
        const capacityValue = Number(capProduct.capacity);
        if (Number.isFinite(capacityValue) && capacityValue > 0) {
          const guestTotal = adults + children3Plus + childrenUnder3;
          if (guestTotal > capacityValue) {
            return NextResponse.json({ error: "The selected product exceeds the available capacity for this booking." }, { status: 400 });
          }
        }
      }
    }

    const reservationCode = `CHM-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`;

    const payload = {
      customer_name: fullName,
      phone_number: phoneNumber,
      email,
      booking_date: bookingDate,
      booking_time: bookingTime,
      adults,
      children_3_plus: children3Plus,
      children_under_3: childrenUnder3,
      selected_area_id: areaId || null,
      selected_equipment_ids: selectedEquipmentIds,
      selected_paid_activity_id: selectedPaidActivityId || null,
      selected_tent_area_id: selectedTentAreaId || null,
      selected_photo_shoot_id: selectedPhotoShootId || null,
      entrance_fee_total: finalBreakdown.entranceFeeTotal,
      additional_total: finalBreakdown.additionalTotal,
      total_price: finalTotal,
      reservation_code: reservationCode,
      booking_status: "pending",
      payment_status: "pending",
      notes: customerNotes,
    };

    const { data, error } = await supabaseAdmin
      .from("bookings")
      .insert([payload])
      .select("id, reservation_code")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: AREA_SLOT_CONFLICT_MESSAGE }, { status: 409 });
      }

      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const response = NextResponse.json({ bookingId: data?.id ?? null, reservationCode: data?.reservation_code ?? reservationCode, success: true }, { status: 201 });
    if (data?.id) {
      await setBookingAccessCookie(response, data.id);
    }
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to submit booking.",
      },
      { status: 500 },
    );
  }
}
