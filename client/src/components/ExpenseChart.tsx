import { Bar, BarChart, XAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from './ui/chart';
import type { ChartConfig } from './ui/chart';

const chartConfig = {
  amount: {
    label: 'Amount (₹)',
    color: '#fff',
  },
} satisfies ChartConfig;

type ChartElement = {
  [key: string]: string | number;
};

/** Bar chart of totals per period; `amount` is in rupees. */
export function ExpenseChart({
  chartData,
  labelKey,
}: {
  chartData: ChartElement[];
  labelKey: string;
}) {
  return (
    <ChartContainer
      config={chartConfig}
      className="min-h-[200px] py-12 bg-zinc-900 rounded-xl my-4 p-4">
      <BarChart accessibilityLayer data={chartData}>
        <ChartTooltip
          content={<ChartTooltipContent />}
          cursor={false}
        />
        <XAxis
          dataKey={labelKey}
          tickLine={false}
          tickMargin={10}
          axisLine={false}
          tickFormatter={(value) => String(value).slice(0, 30)}
        />

        <Bar
          dataKey="amount"
          fill="var(--color-amount)"
          radius={4}
        />
      </BarChart>
    </ChartContainer>
  );
}
