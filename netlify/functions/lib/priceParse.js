// Parses free-text price strings into numeric priceMin / priceMax.
// Handles formats like "$10-$50", "$10–$50", "$10 to $50", "Under $25",
// "From $15", "$20+", "$20" (single price → min == max).

const DASH = /[-–—]/;

export function parsePriceRange(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase().replace(/,/g, "");
  if (!s) return null;

  const nums = [...s.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1])).filter(Number.isFinite);

  if (/^under|less than|below|up to/.test(s) && nums.length >= 1) {
    return { priceMin: 0, priceMax: nums[0] };
  }
  if (/^(from|starting|over|above|more than)/.test(s) && nums.length >= 1) {
    return { priceMin: nums[0], priceMax: null };
  }
  if (/\d\+\s*$/.test(s) && nums.length >= 1) {
    return { priceMin: nums[0], priceMax: null };
  }
  if (nums.length >= 2 && (DASH.test(s) || /\bto\b/.test(s))) {
    const [a, b] = nums;
    return { priceMin: Math.min(a, b), priceMax: Math.max(a, b) };
  }
  if (nums.length === 1) {
    return { priceMin: nums[0], priceMax: nums[0] };
  }
  return null;
}

// Normalizes profile.pricePerProduct entries.
// Accepts [{name, price}], or string entries like "buzz cut $15", "fade — 25".
export function normalizePricePerProduct(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    if (!item) continue;
    if (typeof item === "object" && item.name) {
      const price = Number(item.price);
      out.push({ name: String(item.name).trim(), price: Number.isFinite(price) ? price : null });
      continue;
    }
    if (typeof item === "string") {
      const m = item.match(/^(.+?)[\s:–—-]+\$?\s*(\d+(?:\.\d+)?)/);
      if (m) {
        out.push({ name: m[1].trim(), price: Number(m[2]) });
      } else {
        out.push({ name: item.trim(), price: null });
      }
    }
  }
  return out;
}
