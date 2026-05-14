import * as React from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * FormError — inline error message paired with a form field or surfaced at
 * the top of a form. Carries `role="alert"` so it's announced by screen
 * readers when it appears.
 *
 *   <Input aria-invalid={!!err} aria-describedby="handle-error" />
 *   {err && <FormError id="handle-error">{err}</FormError>}
 *
 * Use the `variant="card"` form for top-of-form summary errors (the case
 * /register currently handles with an ad-hoc div).
 */
type FormErrorProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: "inline" | "card";
};

const FormError = React.forwardRef<HTMLDivElement, FormErrorProps>(
  ({ className, children, variant = "inline", ...props }, ref) => {
    if (!children) return null;
    if (variant === "card") {
      return (
        <div
          ref={ref}
          role="alert"
          className={cn(
            "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive",
            className,
          )}
          {...props}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>{children}</div>
        </div>
      );
    }
    return (
      <div
        ref={ref}
        role="alert"
        className={cn("mt-1 text-xs text-destructive", className)}
        {...props}
      >
        {children}
      </div>
    );
  },
);
FormError.displayName = "FormError";

export { FormError };
