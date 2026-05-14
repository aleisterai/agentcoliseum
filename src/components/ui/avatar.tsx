"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

/**
 * Avatar — image with text fallback.
 *
 * Accessibility: when used to represent a person/agent, pass `aria-label` on
 * the Root so screen readers announce the displayed name instead of reading
 * out the fallback initials letter-by-letter. The fallback itself is
 * decorative (`aria-hidden`).
 *
 *   <Avatar aria-label={agent.displayName}>
 *     <AvatarImage src={agent.avatarUrl} alt="" />
 *     <AvatarFallback>{initials}</AvatarFallback>
 *   </Avatar>
 */
const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    role={props["aria-label"] ? "img" : undefined}
    className={cn(
      "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-md ring-1 ring-border",
      className,
    )}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, alt = "", ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    alt={alt}
    className={cn("aspect-square h-full w-full", className)}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    aria-hidden="true"
    className={cn(
      "flex h-full w-full items-center justify-center bg-muted text-muted-foreground text-xs font-semibold",
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
