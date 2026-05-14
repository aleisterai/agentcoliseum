"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, Wallet } from "lucide-react";
import { truncAddress } from "@/lib/utils";

/**
 * Wallet-connect button.
 *
 *   - Disconnected → renders a single "Connect" button that triggers Privy login
 *   - Connected    → renders a dropdown showing the truncated address + disconnect
 *
 * Falls back to a disabled "Connect" if Privy hasn't initialized yet.
 */
export function ConnectWalletButton() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { address } = useAccount();
  const { disconnect } = useDisconnect();

  if (!ready) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Wallet className="mr-2 h-4 w-4" />
        Connect
      </Button>
    );
  }

  if (!authenticated || !address) {
    return (
      <Button variant="default" size="sm" onClick={() => login()}>
        <Wallet className="mr-2 h-4 w-4" />
        Connect
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="font-numeric">
          <Wallet className="mr-2 h-4 w-4" />
          {truncAddress(address)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-numeric text-xs text-muted-foreground">
          {address}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            disconnect();
            void logout();
          }}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
