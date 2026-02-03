import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"

import { ScrollArea } from "@/components/primitives/ScrollArea"
import { cn } from "@/utils/tailwind"

// Extend TanStack Table's ColumnMeta to include our custom properties
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    align?: "left" | "center" | "right"
    width?: string | number
    headerClassName?: string
    cellClassName?: string
  }
}

interface DataTableClassNames {
  container?: string
  table?: string
  thead?: string
  tbody?: string
  headerRow?: string
  row?: string
  headerCell?: string
  cell?: string
}

interface DataTableProps<TData> {
  data: TData[]
  columns: ColumnDef<TData>[]
  striped?: boolean
  hoverable?: boolean
  fixedLayout?: boolean
  classNames?: DataTableClassNames
  getRowClassName?: (row: TData) => string | undefined
}

export function DataTable<TData>({
  data,
  columns,
  striped = false,
  hoverable = false,
  fixedLayout = true,
  classNames = {},
  getRowClassName,
}: DataTableProps<TData>) {
  const table = useReactTable({
    data,
    columns,
    defaultColumn: { size: 0 },
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <table
      className={cn(
        "border-separate border-spacing-0 text-xs",
        fixedLayout ? "w-full table-fixed" : "w-max",
        classNames.table
      )}
    >
      <thead className={classNames.thead}>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id} className={classNames.headerRow}>
            {hg.headers.map((header) => (
              <th
                key={header.id}
                style={{
                  width:
                    header.column.columnDef.meta?.width ??
                    (fixedLayout && header.column.getSize() ? header.column.getSize() : undefined),
                }}
                className={cn(
                  "sticky top-0 z-10 bg-background p-2 px-1.5 first:pl-2 last:pr-2 align-middle font-bold uppercase text-foreground whitespace-nowrap overflow-hidden text-ellipsis",
                  header.column.columnDef.meta?.align === "center" && "text-center",
                  header.column.columnDef.meta?.align === "right" && "text-right",
                  header.column.columnDef.meta?.align !== "center" &&
                    header.column.columnDef.meta?.align !== "right" &&
                    "text-left",
                  classNames.headerCell,
                  header.column.columnDef.meta?.headerClassName
                )}
              >
                {header.isPlaceholder ? null : (
                  flexRender(header.column.columnDef.header, header.getContext())
                )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody className={classNames.tbody}>
        {table.getRowModel().rows.map((row) => (
          <tr
            key={row.id}
            className={cn(
              "text-muted-foreground transition-colors bg-accent-background",
              hoverable && "hover:bg-accent",
              striped && "even:bg-subtle-background",
              classNames.row,
              getRowClassName?.(row.original)
            )}
          >
            {row.getVisibleCells().map((cell) => (
              <td
                key={cell.id}
                style={{
                  width:
                    cell.column.columnDef.meta?.width ??
                    (fixedLayout && cell.column.getSize() ? cell.column.getSize() : undefined),
                }}
                className={cn(
                  "px-2 py-1.5 align-middle whitespace-nowrap overflow-hidden text-ellipsis border-b border-background",
                  cell.column.columnDef.meta?.align === "center" && "text-center",
                  cell.column.columnDef.meta?.align === "right" && "text-right",
                  cell.column.columnDef.meta?.align !== "center" &&
                    cell.column.columnDef.meta?.align !== "right" &&
                    "text-left",
                  classNames.cell,
                  cell.column.columnDef.meta?.cellClassName
                )}
              >
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function DataTableScrollArea<TData>({
  className = "",
  ...props
}: React.ComponentProps<typeof ScrollArea> & DataTableProps<TData>) {
  return (
    <ScrollArea className={cn("relative pointer-events-auto min-h-0 min-w-0", className)}>
      <DataTable {...props} />
    </ScrollArea>
  )
}
