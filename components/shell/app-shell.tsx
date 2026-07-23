"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Anchor,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  BellRing,
  BadgePercent,
  ClipboardCheck,
  BookOpen,
  ClipboardList,
  Handshake,
  HandCoins,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  Moon,
  Package,
  ReceiptText,
  Send,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Sun,
  Truck,
  Wallet,
  Boxes,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { ApprovalsBadge } from "@/components/shell/approvals-badge";
import {
  DeliveriesBadge,
  ReceivablesBadge,
  ShopDeliveriesBadge,
  ShopLowStockBadge,
  ShopReceivablesBadge,
  StockAlertsBadge,
  SuppliersBadge,
  WarrantiesBadge,
} from "@/components/shell/nav-badges";
import { NotificationBell } from "@/components/shell/notification-bell";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/** Owner sidebar count badges, keyed by the nav href they attach to. */
const OWNER_BADGES: Record<string, React.FC<{ active?: boolean; initialCount?: number }>> = {
  "/approvals": ApprovalsBadge,
  "/deliveries": DeliveriesBadge,
  "/stock-alerts": StockAlertsBadge,
  "/suppliers": SuppliersBadge,
  "/receivables": ReceivablesBadge,
  "/warranties": WarrantiesBadge,
};

/** Employee (shop) sidebar count badges — the "needs your attention" numbers. */
const EMPLOYEE_BADGES: Record<string, React.FC<{ active?: boolean; initialCount?: number }>> = {
  "/shop/deliveries": ShopDeliveriesBadge,
  "/shop/low-stock": ShopLowStockBadge,
  "/shop/receivables": ShopReceivablesBadge,
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const OWNER_NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/reports", label: "Reports", icon: BarChart3 },
    ],
  },
  {
    // Ordered as stock actually flows: bought from a supplier → into master →
    // delivered to shops — then the checks on it (alerts, counts, the ledger).
    label: "Inventory",
    items: [
      { href: "/suppliers", label: "Suppliers", icon: Handshake },
      { href: "/master-inventory", label: "Master Inventory", icon: Boxes },
      { href: "/deliveries", label: "Deliveries & Returns", icon: Truck },
      { href: "/stock-alerts", label: "Stock Alerts", icon: BellRing },
      { href: "/counts", label: "Monthly Count", icon: ClipboardList },
      { href: "/movements", label: "Movements", icon: BookOpen },
    ],
  },
  {
    label: "Sales & Service",
    items: [
      { href: "/approvals", label: "Approval Queue", icon: ClipboardCheck },
      { href: "/receivables", label: "Receivables", icon: HandCoins },
      { href: "/warranties", label: "Warranties & Serials", icon: ShieldCheck },
      { href: "/suki-cards", label: "Suki Cards", icon: BadgePercent },
    ],
  },
  {
    // Settings lives in the profile menu (top right), not here — it's about
    // the owner's account and business config, not a place stock or money
    // moves through.
    label: "Administration",
    items: [
      { href: "/shops", label: "Shops & Employees", icon: Store },
      { href: "/payroll", label: "Payroll", icon: Wallet },
      { href: "/expenses", label: "Expenses", icon: ReceiptText },
    ],
  },
];

const EMPLOYEE_NAV: NavGroup[] = [
  {
    label: "My Shop",
    items: [
      { href: "/shop", label: "My Shop Stock", icon: Package },
      { href: "/shop/deliveries", label: "Incoming Deliveries", icon: Truck },
      { href: "/shop/transfers", label: "Transfers", icon: ArrowLeftRight },
      { href: "/shop/low-stock", label: "Low Stock", icon: BellRing },
    ],
  },
  {
    label: "Daily Work",
    items: [
      { href: "/shop/record-sale", label: "Record Sale", icon: ShoppingCart },
      { href: "/shop/record-loss", label: "Record Loss", icon: AlertTriangle },
      { href: "/shop/receivables", label: "Receivables", icon: HandCoins },
      { href: "/shop/expenses", label: "Expenses", icon: ReceiptText },
      { href: "/shop/warranties", label: "Warranties", icon: ShieldCheck },
      { href: "/shop/submissions", label: "Submissions", icon: Send },
    ],
  },
];

export interface AppShellProps {
  variant: "owner" | "employee";
  userName: string;
  /** e.g. "Owner" or the shop's name for employees */
  contextLabel: string;
  /** server-computed sidebar counts, keyed by nav href — seeds the badges'
   *  first paint so they don't pop in after a client fetch. */
  badgeCounts?: Record<string, number>;
  children: React.ReactNode;
}

function isActive(pathname: string, href: string, allHrefs: string[]) {
  if (pathname === href) return true;
  // Prefix match, but only when no more-specific item matches (e.g. /shop vs /shop/record-sale)
  if (!pathname.startsWith(href + "/")) return false;
  return !allHrefs.some((h) => h !== href && pathname.startsWith(h));
}

function NavLinks({
  groups,
  pathname,
  onNavigate,
  badges,
  badgeCounts,
}: {
  groups: NavGroup[];
  pathname: string;
  onNavigate?: () => void;
  badges?: Record<string, React.FC<{ active?: boolean; initialCount?: number }>>;
  badgeCounts?: Record<string, number>;
}) {
  const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
  return (
    <nav className="flex flex-col gap-4 px-3">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            {group.label}
          </div>
          {group.items.map((item) => {
            const active = isActive(pathname, item.href, hrefs);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
                {badges?.[item.href] &&
                  React.createElement(badges[item.href], {
                    active,
                    initialCount: badgeCounts?.[item.href],
                  })}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-6 py-5">
      <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Anchor className="size-4" />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold">Gerwin Trading</div>
        <div className="text-xs text-muted-foreground">Inventory System</div>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle dark mode"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="size-4 hidden dark:block" />
    </Button>
  );
}

const SUPPORT_URL = "https://www.facebook.com/rbrtmstrjr09";

function useSignOut() {
  const router = useRouter();
  return async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };
}

/**
 * Account actions live here, not in the sidebar — Settings, Support and
 * Sign out are about the ACCOUNT, not a place to navigate stock or money
 * through, so they belong under the identity that's always pinned top-right
 * rather than competing for space with the nav on every page.
 */
function UserMenu({
  variant,
  userName,
  contextLabel,
}: {
  variant: "owner" | "employee";
  userName: string;
  contextLabel: string;
}) {
  const signOut = useSignOut();
  const initials = userName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
            {initials || "?"}
          </span>
          <span className="hidden sm:block text-sm font-medium">{userName}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="text-sm font-medium">{userName}</div>
          <div className="text-xs font-normal text-muted-foreground">{contextLabel}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Employees have no business config to reach — same reason /settings
            never appeared in their sidebar. */}
        {variant === "owner" && (
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings className="size-4" />
              Settings
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
            <LifeBuoy className="size-4" />
            Support
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut} variant="destructive">
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ variant, userName, contextLabel, badgeCounts, children }: AppShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const groups = variant === "owner" ? OWNER_NAV : EMPLOYEE_NAV;

  return (
    <div className="flex h-svh w-full overflow-hidden print:h-auto print:overflow-visible">
      {/* Desktop sidebar — fixed; only the content column scrolls */}
      <aside className="thin-scrollbar hidden md:flex w-64 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar">
        <Brand />
        <NavLinks
          groups={groups}
          pathname={pathname}
          badges={variant === "owner" ? OWNER_BADGES : EMPLOYEE_BADGES}
                badgeCounts={badgeCounts}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden print:overflow-visible">
        {/* Top bar — outside the scroll region so the scrollbar gutter never
            shifts its right-aligned controls between scrolling pages and not */}
        <header className="z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          {/* Mobile nav */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="flex w-72 flex-col bg-sidebar p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <Brand />
              <NavLinks
                groups={groups}
                pathname={pathname}
                onNavigate={() => setMobileOpen(false)}
                badges={variant === "owner" ? OWNER_BADGES : EMPLOYEE_BADGES}
                badgeCounts={badgeCounts}
              />
            </SheetContent>
          </Sheet>

          <div className="flex-1" />
          <NotificationBell variant={variant} />
          <ThemeToggle />
          <UserMenu variant={variant} userName={userName} contextLabel={contextLabel} />
        </header>

        <div className="thin-scrollbar flex flex-1 flex-col overflow-y-auto print:overflow-visible">
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
