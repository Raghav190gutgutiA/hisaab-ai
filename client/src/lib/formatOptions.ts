import { BarChart3, Braces, Table2 } from 'lucide-react';
import type { ExpenseFormat } from '../type.ts';

export const FORMAT_OPTIONS: {
  value: ExpenseFormat;
  label: string;
  description: string;
  Icon: typeof Table2;
}[] = [
  { value: 'table', label: 'Table', description: 'Sortable list', Icon: Table2 },
  { value: 'json', label: 'JSON', description: 'Raw data', Icon: Braces },
  { value: 'chart', label: 'Chart', description: 'Daily totals', Icon: BarChart3 },
];
