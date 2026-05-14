import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Text input. Pass `aria-invalid` (boolean) to opt into the error visual —
 * border + ring switch to destructive. Pair with `aria-describedby` pointing
 * at a `<FormError>` for the message.
 *
 * Example:
 *   <Input aria-invalid={hasError} aria-describedby="handle-error" />
 *   {hasError && <FormError id="handle-error">{message}</FormError>}
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          "flex h-9 w-full rounded-md border border-border bg-input px-3 py-1 text-sm text-foreground placeholder:text-muted-foreground transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/40",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
