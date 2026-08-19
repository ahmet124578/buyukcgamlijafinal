"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type CalendarBooking = {
  id: string;
  customer_name: string | null;
  booking_date: string | null;
  booking_time: string | null;
  adults: number | null;
  children_3_plus: number | null;
  children_under_3: number | null;
  total_price: number | null;
  booking_status: string | null;
  payment_status: string | null;
};

type DaySummary = {
  date: string;
  reservations: CalendarBooking[];
  activeReservations: CalendarBooking[];
  adults: number;
  children: number;
  visitors: number;
  revenue: number;
};

const weekDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function getTodayInSouthAfrica() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function toMonthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function fromMonthKey(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

function toDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getVisitorCounts(booking: CalendarBooking) {
  const adults = Number(booking.adults ?? 0);
  const children = Number(booking.children_3_plus ?? 0) + Number(booking.children_under_3 ?? 0);
  return { adults, children, total: adults + children };
}

function isActiveBooking(booking: CalendarBooking) {
  const bookingStatus = String(booking.booking_status ?? "").trim().toLowerCase();
  const paymentStatus = String(booking.payment_status ?? "").trim().toLowerCase();
  return ["pending", "confirmed"].includes(bookingStatus) && !["rejected", "cancelled", "failed", "refunded", "refund_failed"].includes(paymentStatus);
}

function formatMoney(value: number) {
  return `R ${value.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatStatus(value: string | null) {
  const normalized = String(value ?? "pending").trim().toLowerCase();
  if (normalized === "paid" || normalized === "verified" || normalized === "approved") return "Paid";
  if (normalized === "confirmed") return "Confirmed";
  if (normalized === "cancelled" || normalized === "canceled") return "Cancelled";
  if (normalized === "completed") return "Completed";
  return "Pending";
}

function getStatusClass(value: string | null) {
  const status = formatStatus(value);
  if (status === "Confirmed" || status === "Paid") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "Cancelled") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

export function ReservationCalendar({ bookings, initialMonth }: { bookings: CalendarBooking[]; initialMonth: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = getTodayInSouthAfrica();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const monthKey = initialMonth;
  const monthDate = fromMonthKey(monthKey);

  const summaries = useMemo(() => {
    const grouped = new Map<string, DaySummary>();

    bookings.forEach((booking) => {
      if (!booking.booking_date) return;
      const current = grouped.get(booking.booking_date) ?? {
        date: booking.booking_date,
        reservations: [],
        activeReservations: [],
        adults: 0,
        children: 0,
        visitors: 0,
        revenue: 0,
      };
      const visitors = getVisitorCounts(booking);
      current.reservations.push(booking);
      if (isActiveBooking(booking)) {
        current.activeReservations.push(booking);
        current.adults += visitors.adults;
        current.children += visitors.children;
        current.visitors += visitors.total;
        current.revenue += Number(booking.total_price ?? 0);
      }
      grouped.set(booking.booking_date, current);
    });

    return grouped;
  }, [bookings]);

  const calendarCells = useMemo(() => {
    const firstDay = monthDate.getUTCDay();
    const mondayOffset = firstDay === 0 ? 6 : firstDay - 1;
    const daysInMonth = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate();
    const cells: Array<{ date: string; day: number } | null> = Array.from({ length: mondayOffset }, () => null);
    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push({ date: toDateKey(new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), day))), day });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [monthDate]);

  const selectedSummary = selectedDate ? summaries.get(selectedDate) ?? null : null;
  const monthLabel = new Intl.DateTimeFormat("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" }).format(monthDate);

  const moveMonth = (offset: number) => {
    const next = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + offset, 1));
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("calendarMonth", toMonthKey(next));
    nextParams.delete("bookingId");
    router.push(`${pathname}?${nextParams.toString()}`);
    setSelectedDate(null);
  };

  return (
    <section className="min-w-0 overflow-hidden rounded-[2rem] border border-slate-200 bg-white p-4 shadow-[0_16px_36px_rgba(15,23,42,0.05)] sm:p-6" aria-labelledby="reservation-calendar-title">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">Reservations</p>
          <h2 id="reservation-calendar-title" className="mt-2 text-2xl font-black tracking-tight text-slate-900">Reservation Calendar</h2>
          <p className="mt-1 text-sm text-slate-500">View reservations and visitor counts by day.</p>
        </div>
        <button type="button" onClick={() => { const nextParams = new URLSearchParams(searchParams.toString()); nextParams.set("calendarMonth", today.slice(0, 7)); nextParams.delete("bookingId"); router.push(`${pathname}?${nextParams.toString()}`); setSelectedDate(today); }} className="shrink-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100">Today</button>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <button type="button" aria-label="Previous month" onClick={() => moveMonth(-1)} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-lg font-semibold text-slate-700 transition hover:bg-slate-50">&lsaquo;</button>
        <h3 className="min-w-0 truncate text-center text-lg font-black capitalize text-slate-900 sm:text-xl">{monthLabel}</h3>
        <button type="button" aria-label="Next month" onClick={() => moveMonth(1)} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-lg font-semibold text-slate-700 transition hover:bg-slate-50">&rsaquo;</button>
      </div>

      <div className="mt-5 grid min-w-0 grid-cols-7 gap-1 sm:gap-2" role="grid" aria-label={monthLabel}>
        {weekDays.map((day) => <div key={day} className="min-w-0 px-1 py-2 text-center text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 sm:text-xs">{day}</div>)}
        {calendarCells.map((cell, index) => {
          const summary = cell ? summaries.get(cell.date) : null;
          const isSelected = cell?.date === selectedDate;
          const isToday = cell?.date === today;
          return (
            <button
              key={cell?.date ?? `empty-${index}`}
              type="button"
              disabled={!cell}
              onClick={() => cell && setSelectedDate(cell.date)}
              className={`min-w-0 overflow-hidden rounded-xl border p-1.5 text-left transition sm:min-h-20 sm:p-2 ${!cell ? "border-transparent bg-transparent" : isSelected ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-100" : isToday ? "border-slate-900 bg-slate-50" : "border-slate-100 bg-white hover:border-emerald-200 hover:bg-emerald-50/40"}`}
              aria-label={cell ? `${cell.date}${summary ? `, ${summary.visitors} visitors` : ""}` : undefined}
            >
              {cell && <>
                <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${isToday ? "bg-slate-900 text-white" : "text-slate-700"}`}>{cell.day}</span>
                {summary && summary.activeReservations.length > 0 && <span className="mt-1 block truncate text-[9px] font-semibold text-emerald-700 sm:text-[11px]">{summary.visitors} guests</span>}
                {summary && summary.activeReservations.length > 0 && <span className="mt-0.5 block truncate text-[9px] text-slate-400 sm:text-[10px]">{summary.activeReservations.length} booking{summary.activeReservations.length === 1 ? "" : "s"}</span>}
              </>}
            </button>
          );
        })}
      </div>

      {selectedSummary && <div className="mt-6 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0"><h3 className="truncate text-lg font-black text-slate-900">{new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${selectedSummary.date}T00:00:00Z`))}</h3><p className="mt-1 text-sm text-slate-500">{selectedSummary.reservations.length} reservation{selectedSummary.reservations.length === 1 ? "" : "s"} on this date</p></div>
          <span className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">{selectedSummary.activeReservations.length} active</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[["Reservations", selectedSummary.activeReservations.length], ["Adults", selectedSummary.adults], ["Children", selectedSummary.children], ["Total Visitors", selectedSummary.visitors], ["Estimated Revenue", formatMoney(selectedSummary.revenue)]] .map(([label, value]) => <div key={String(label)} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3"><div className="truncate text-xs text-slate-500">{label}</div><div className="mt-1 truncate text-base font-black text-slate-900">{value}</div></div>)}
        </div>
        <div className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {selectedSummary.reservations.map((booking) => { const visitors = getVisitorCounts(booking); return <div key={booking.id} className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-3 text-sm sm:px-4"><span className="w-12 shrink-0 font-semibold text-slate-500">{booking.booking_time || "—"}</span><span className="min-w-0 flex-1 truncate font-semibold text-slate-900">{booking.customer_name || "Unknown"}</span><span className="shrink-0 text-slate-500">{visitors.total} guest{visitors.total === 1 ? "" : "s"}</span><span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold ${getStatusClass(booking.booking_status)}`}>{formatStatus(booking.booking_status)}</span></div>; })}
        </div>
      </div>}
    </section>
  );
}
