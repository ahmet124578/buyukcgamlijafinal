"use client";

import { type ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import { BankTransferDetailsCard } from "@/components/booking/bank-transfer-payment-card";
import { formatCurrency } from "@/lib/payments/manual";
import type { BookingPaymentSummary } from "@/lib/payments/manual";

interface BankTransferDisplayProps {
  booking: BookingPaymentSummary;
}

interface BankDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  branchCode: string;
  swiftCode: string;
  iban: string;
}

function maskValue(value: string, keepStart = 4, keepEnd = 4): string {
  const trimmed = value.trim();
  if (!trimmed) return "—";
  if (trimmed.length <= keepStart + keepEnd) return trimmed;

  const hiddenChars = Math.max(4, trimmed.length - keepStart - keepEnd);
  return `${trimmed.slice(0, keepStart)}${"*".repeat(hiddenChars)}${trimmed.slice(-keepEnd)}`;
}

const ALLOWED_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_FILE_SIZE = 4 * 1024 * 1024;

export function BankTransferDisplay({ booking }: BankTransferDisplayProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [bankDetails, setBankDetails] = useState<BankDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [receiptName, setReceiptName] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmittingVerification, setIsSubmittingVerification] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reservationCode = booking.reservation_code || booking.id;

  useEffect(() => {
    async function fetchBankDetails() {
      try {
        const response = await fetch("/api/payments/bank-details");
        const data = await response.json();
        setBankDetails(data);
      } catch (error) {
        console.error("Failed to fetch bank details:", error);
      } finally {
        setLoading(false);
      }
    }

    void fetchBankDetails();
  }, []);

  useEffect(() => {
    if (!fileToUpload) {
      setPreviewUrl(null);
      return;
    }

    if (fileToUpload.type.startsWith("image/")) {
      const objectUrl = URL.createObjectURL(fileToUpload);
      setPreviewUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }

    setPreviewUrl(null);
  }, [fileToUpload]);

  const validateFile = (file: File) => {
    const extension = file.name.split(".").pop()?.toLowerCase();
    const mimeOk = ALLOWED_TYPES.includes(file.type) || ["jpg", "jpeg", "png", "pdf"].includes(extension ?? "");

    if (!mimeOk) {
      return "Unsupported file type. Please upload a JPG, PNG, or PDF only.";
    }

    if (file.size <= 0) {
      return "The uploaded file is empty.";
    }

    if (file.size > MAX_FILE_SIZE) {
      return "Receipt must be smaller than 4MB.";
    }

    return null;
  };

  const handleSelectedFile = (file: File | null) => {
    if (!file) return;

    const validationError = validateFile(file);
    if (validationError) {
      setErrorMessage(validationError);
      setFileToUpload(null);
      return;
    }

    setErrorMessage(null);
    setStatusMessage(null);
    setFileToUpload(file);
    setUploadProgress(0);
  };

  const handleReceiptUpload = async () => {
    if (!fileToUpload) {
      setErrorMessage("Please choose a valid receipt file first.");
      return;
    }

    setUploading(true);
    setErrorMessage(null);
    setStatusMessage(null);
    setUploadProgress(15);

    try {
      const formData = new FormData();
      formData.append("bookingId", booking.id);
      formData.append("receipt", fileToUpload);

      const response = await fetch("/api/payments/manual/upload-receipt", {
        method: "POST",
        body: formData,
      });

      const result = (await response.json()) as { error?: string; receiptUrl?: string; fileName?: string; message?: string };

      if (!response.ok || !result.receiptUrl) {
        throw new Error(result.error || "Receipt upload failed.");
      }

      setUploadProgress(100);
      setReceiptUrl(result.receiptUrl);
      setReceiptName(result.fileName || fileToUpload.name);
      setStatusMessage(result.message || "Receipt uploaded successfully.");
      setFileToUpload(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Receipt upload failed.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleVerificationSubmit = async () => {
    if (!receiptUrl) {
      setErrorMessage("Please upload a payment receipt before submitting it for verification.");
      return;
    }

    setIsSubmittingVerification(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const response = await fetch("/api/payments/manual/submit-for-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: booking.id }),
      });

      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) {
        throw new Error(result.error || "Unable to submit your receipt for verification.");
      }

      setStatusMessage(result.message || "Receipt submitted successfully. Your booking payment is now under review.");
      window.location.reload();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to submit your receipt.");
    } finally {
      setIsSubmittingVerification(false);
    }
  };

  const handleDrag = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(event.type === "dragenter" || event.type === "dragover");
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);
    const droppedFile = event.dataTransfer.files?.[0] ?? null;
    handleSelectedFile(droppedFile);
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    handleSelectedFile(selected);
  };

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 1800);
    } catch (error) {
      console.error("Clipboard copy failed:", error);
      setCopiedField(`${field}-error`);
      window.setTimeout(() => setCopiedField(null), 1800);
    }
  };

  const detailRows = bankDetails
    ? [
        { key: "bankName", label: "Bank Name", value: bankDetails.bankName },
        { key: "accountName", label: "Account Name", value: bankDetails.accountName },
        { key: "accountNumber", label: "Account Number", value: bankDetails.accountNumber, masked: maskValue(bankDetails.accountNumber, 4, 4) },
        { key: "branchCode", label: "Branch Code", value: bankDetails.branchCode, masked: maskValue(bankDetails.branchCode, 2, 2) },
        ...(bankDetails.iban ? [{ key: "iban", label: "IBAN", value: bankDetails.iban, masked: maskValue(bankDetails.iban, 4, 4) }] : []),
      ]
    : [];

  const isWithinThreeDays = booking.booking_date ? (() => {
    const date = new Date(`${booking.booking_date}T00:00:00Z`);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const diffDays = (date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays < 3;
  })() : false;

  if (loading || !bankDetails) {
    return (
      <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-5 shadow-sm">
        <div className="text-center text-sm text-slate-600">Loading bank details...</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-[1.5rem] border border-emerald-200 bg-emerald-50 p-4 sm:p-5">
        <div className="text-sm font-semibold text-emerald-900">Bank Transfer / EFT</div>
        <p className="mt-2 text-sm leading-6 text-emerald-800">
          Please make a transfer using the account details below. Use your booking reference as the payment reference so we can match your payment with your reservation.
        </p>
      </div>

      {isWithinThreeDays && (
        <div className="rounded-[1.5rem] border border-amber-300 bg-amber-50 p-4 text-left">
          <div className="text-sm font-black uppercase tracking-[0.2em] text-amber-900">Important</div>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            IMPORTANT: Your booking is within 3 days. Payment must be made immediately. Your reservation will only be confirmed after the payment has been verified.
          </p>
        </div>
      )}

      <div className="rounded-[1.5rem] border border-slate-200 bg-white p-4 shadow-[0_16px_36px_rgba(15,23,42,0.04)] sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Booking Summary</div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Reference</div>
            <div className="mt-2 font-mono text-sm font-bold text-slate-900">{reservationCode}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Date</div>
            <div className="mt-2 text-sm font-bold text-slate-900">{booking.booking_date || "—"}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Time</div>
            <div className="mt-2 text-sm font-bold text-slate-900">{booking.booking_time || "—"}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Guests</div>
            <div className="mt-2 text-sm font-bold text-slate-900">{Number(booking.adults ?? 0) + Number(booking.children_3_plus ?? 0) + Number(booking.children_under_3 ?? 0)}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:col-span-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Total Amount</div>
            <div className="mt-2 text-2xl font-black tracking-tight text-slate-900">{formatCurrency(booking.total_price)}</div>
          </div>
        </div>
      </div>

      <div className="rounded-[1.5rem] border border-slate-200 bg-white p-4 shadow-[0_16px_36px_rgba(15,23,42,0.04)] sm:p-5">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Bank Account</div>

        <div className="mt-4 space-y-3">
          {detailRows.map((detail) => (
            <div key={detail.key} className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{detail.label}</div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(detail.value, detail.key)}
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-50"
                  aria-label={`Copy ${detail.label}`}
                >
                  <span aria-hidden="true">⧉</span>
                  {copiedField === detail.key ? "Copied!" : "Copy"}
                </button>
              </div>

              <div className="mt-2 font-mono text-sm font-semibold text-slate-900 sm:text-base">
                {detail.masked ?? detail.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-[1.5rem] border border-slate-200 bg-white p-4 shadow-[0_16px_36px_rgba(15,23,42,0.04)] sm:p-5">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Upload Transfer Receipt</div>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          After making the bank transfer, upload your payment receipt below. Your reservation will only be confirmed after our team verifies the payment.
        </p>

        <div
          className={`mt-4 rounded-[1.5rem] border-2 border-dashed p-4 transition ${
            isDragActive ? "border-emerald-500 bg-emerald-50" : "border-slate-300 bg-slate-50"
          }`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700">⬆️</div>
            <div>
              <div className="text-base font-semibold text-slate-900">Drag and drop your receipt here</div>
              <div className="mt-1 text-sm text-slate-500">Accepted files: JPG, JPEG, PNG, PDF</div>
            </div>

            <input
              ref={inputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
              className="hidden"
              onChange={handleFileInput}
              disabled={uploading}
            />

            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {uploading ? "Uploading..." : "Choose File"}
            </button>
          </div>

          {uploadProgress > 0 && uploadProgress < 100 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600">
                <span>Upload progress</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${uploadProgress}%` }} />
              </div>
            </div>
          )}
        </div>

        {fileToUpload && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Selected file</div>
                <div className="mt-1 text-sm font-medium text-slate-900">{fileToUpload.name}</div>
              </div>
              <button type="button" onClick={() => setFileToUpload(null)} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
                Remove
              </button>
            </div>

            {previewUrl && (
              <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                <img src={previewUrl} alt="Receipt preview" className="max-h-56 w-full object-contain" />
              </div>
            )}

            <button
              type="button"
              onClick={handleReceiptUpload}
              className="mt-4 inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={uploading}
            >
              {uploading ? "Uploading..." : "Upload Receipt"}
            </button>
          </div>
        )}

        {receiptUrl && (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3.5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Receipt uploaded</div>
                <div className="mt-1 text-sm font-medium text-slate-900">{receiptName || "Transfer receipt"}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={receiptUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50">
                  Open
                </a>
                <button type="button" onClick={() => { setReceiptUrl(null); setReceiptName(null); setStatusMessage("Receipt removed. Upload a replacement if needed."); }} className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50">
                  Replace
                </button>
              </div>
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{errorMessage}</div>
        )}

        {statusMessage && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{statusMessage}</div>
        )}

        {receiptUrl && (
          <button
            type="button"
            onClick={handleVerificationSubmit}
            disabled={isSubmittingVerification}
            className="mt-5 inline-flex w-full items-center justify-center rounded-full bg-amber-500 px-6 py-3 text-sm font-semibold text-white shadow-[0_16px_30px_rgba(245,158,11,0.25)] transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {isSubmittingVerification ? "Submitting..." : "Submit Receipt for Verification"}
          </button>
        )}
      </div>

      <BankTransferDetailsCard />
    </div>
  );
}
