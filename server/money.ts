/**
 * Money is stored as integer paise everywhere. Rupee values only exist at
 * the edges: LLM tool input and display formatting.
 */

export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) {
    throw new Error('Amount must be a finite number');
  }
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/** 12050 -> "₹120.5", 2000 -> "₹20" */
export function formatPaise(paise: number): string {
  return `₹${inrFormatter.format(paise / 100)}`;
}
