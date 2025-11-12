"use client";

import * as React from "react";

import { cn } from "@/utils/tailwind";

function Table({
  className,
  block = false,
  ...props
}: React.ComponentProps<"table"> & { block?: boolean }) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom text-sm",
          block && "border-separate border-spacing-y-px -m-px",
          className
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({
  className,
  block = false,
  ...props
}: React.ComponentProps<"thead"> & { block?: boolean }) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", block && "", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/50 border-t font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  );
}

function TableRow({
  className,
  block = false,
  highlight = false,
  ...props
}: React.ComponentProps<"tr"> & { block?: boolean; highlight?: boolean }) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "data-[state=selected]:bg-muted border-b transition-colors",
        block &&
          block &&
          "[&_td:not([data-slot='table-cell-separator'])]:bg-muted odd:[&_td:not([data-slot='table-cell-separator'])]:bg-muted/60 border-none",
        highlight &&
          "[&_td:not([data-slot='table-cell-separator'])]:bg-fuel/20 odd:[&_td:not([data-slot='table-cell-separator'])]:bg-fuel/20 text-fuel-foreground [&_td:not([data-slot='table-cell-separator'])]:border-fuel",
        className
      )}
      {...props}
    />
  );
}

function TableHead({
  className,
  block = false,
  ...props
}: React.ComponentProps<"th"> & { block?: boolean }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "text-foreground py-2 px-2 mx-2 text-left align-middle font-bold uppercase text-xs tracking-widest whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        block && "bg-muted border-none",
        className
      )}
      {...props}
    />
  );
}

function TableCellSeparator({
  className,
  ...props
}: React.ComponentProps<"th">) {
  return (
    <td
      data-slot="table-cell-separator"
      className={cn("w-px p-0 bg-transparent", className)}
      {...props}
    />
  );
}
function TableCell({
  className,
  block = false,
  inset = false,
  ...props
}: React.ComponentProps<"td"> & { block?: boolean; inset?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        block && "",
        inset && "border-l-3 border-white",
        className
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  );
}

function TableHeadText({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head-title"
      className={cn("px-2", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableCellSeparator,
  TableFooter,
  TableHead,
  TableHeader,
  TableHeadText,
  TableRow,
};
