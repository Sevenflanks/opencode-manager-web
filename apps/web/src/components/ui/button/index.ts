import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Button } from "./Button.vue"

export const buttonVariants = cva(
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-[#50c8c6] text-[#071112] hover:bg-[#71d5d3] focus-visible:ring-[#50c8c6]",
        outline: "border border-[#394146] bg-transparent text-[#e7ebed] hover:bg-[#242a2e] focus-visible:ring-[#50c8c6]",
        destructive: "bg-[#b94e42] text-white hover:bg-[#cf6256] focus-visible:ring-[#cf6256]",
        ghost: "text-[#aeb8bd] hover:bg-[#242a2e] hover:text-white focus-visible:ring-[#50c8c6]",
      },
      size: {
        default: "h-10",
        sm: "h-9 px-3 text-xs",
        icon: "size-10 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
