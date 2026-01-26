import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"

import { cn } from "@/utils/tailwind"

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
}

export function DataTable<TData>({
  data,
  columns,
  striped = false,
  hoverable = false,
  fixedLayout = true,
  classNames = {},
}: DataTableProps<TData>) {
  const table = useReactTable({
    data,
    columns,
    defaultColumn: {},
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className={cn("flex-1 min-h-0 min-w-0 overflow-auto", classNames.container)}>
      <table
        className={cn(
          "w-full border-separate border-spacing-0 text-xs",
          fixedLayout && "table-fixed",
          classNames.table
        )}
      >
        <thead className={classNames.thead}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className={classNames.headerRow}>
              {hg.headers.map((header) => (
                <th
                  key={header.id}
                  style={header.column.getSize() ? { width: header.column.getSize() } : undefined}
                  className={cn(
                    "sticky top-0 z-10 bg-background p-2 px-1.5 first:pl-2 last:pr-2 text-left align-middle font-bold uppercase text-foreground whitespace-nowrap overflow-hidden text-ellipsis",
                    classNames.headerCell
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
                classNames.row
              )}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  style={cell.column.getSize() ? { width: cell.column.getSize() } : undefined}
                  className={cn(
                    "px-2 py-1.5 align-middle whitespace-nowrap overflow-hidden text-ellipsis border-b border-background",
                    classNames.cell
                  )}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
