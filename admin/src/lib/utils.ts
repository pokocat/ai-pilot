// shadcn 约定的 class 合并工具（`cn`）。只服务 admin/src/growth/** 与 admin/src/components/ui/**，
// 旧页面不引用它（旧页面的 class 词汇来自 admin.css，见 admin/DESIGN.md「shadcn 模块（增长组）」）。
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
