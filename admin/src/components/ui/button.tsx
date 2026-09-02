import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

/*
 * 这里比 shadcn 原版多了一层 `forwardRef`，**不能删**（2026-09-02 走查定位到的真 bug）。
 *
 * shadcn 当前生成的组件是按 React 19 写的：函数组件直接收 `ref` 当普通 prop。本仓的 admin 是
 * **React 18.3**，函数组件没有 forwardRef 时 `ref` 会被 React 静默丢掉（生产构建里连那句
 * 「Function components cannot be given refs」的告警都没有）。
 *
 * 后果不是「少个 ref」这么轻：`<DropdownMenuTrigger asChild><Button/></DropdownMenuTrigger>`
 * 这类写法里，Radix 用 `Slot` + `cloneElement(child, { ref })` 把触发器的 ref 交给
 * `PopperAnchor`；ref 丢了 → Popper 拿不到锚点 → floating-ui 永远不 `isPositioned` →
 * 浮层保持在初始的 `transform: translate(0, -200%)`，也就是**菜单挂在视口上方看不见**
 * （DOM 里有、`aria-expanded=true`、尺寸也对，只是画在屏幕外，最难查的一种坏法）。
 * 走查时代理名册的行内「⋯」菜单就是这么坏的。
 *
 * 影响面只有「被 `asChild` 套进 Radix 触发器」的组件，本模块里就是 Button
 * （DropdownMenuTrigger / CollapsibleTrigger 两处）。别的 ui/ 组件把 props 直接摊给 Radix
 * 原语，ref 由原语自己持有，不经过我们这层，所以不需要改。
 * 升级到 React 19 后这层可以去掉。
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }
