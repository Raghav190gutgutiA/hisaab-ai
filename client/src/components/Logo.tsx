/** Hisaab.ai mark: a rupee sign on the brand gradient. */
export function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const box = { sm: 'w-8 h-8 rounded-lg text-base', md: 'w-10 h-10 rounded-xl text-xl', lg: 'w-20 h-20 rounded-2xl text-4xl' }[size];
  return (
    <div
      aria-hidden
      className={`${box} bg-linear-to-br from-purple-500 via-pink-500 to-orange-500 flex items-center justify-center shadow-lg font-bold text-white`}>
      ₹
    </div>
  );
}
