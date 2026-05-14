"use client";

/**
 * Minimal toast queue + hook. Provider in `<Toaster />` (toaster.tsx) imports
 * and re-exports the context.
 *
 *   const { toast } = useToast();
 *   toast({ title: "Agent registered", description: "@alpha is now live" });
 *   toast({ variant: "destructive", title: "Move failed", description: err });
 */
import * as React from "react";
import type { ToastProps } from "./toast";

export type ToastItem = {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  variant?: ToastProps["variant"];
  duration?: number;
};

export type ToastInput = Omit<ToastItem, "id">;

export type ToastContextValue = {
  toasts: ToastItem[];
  toast: (t: ToastInput) => string;
  dismiss: (id?: string) => void;
};

export const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be called inside <Toaster />");
  }
  return ctx;
}
