// Rich, deliberately interlocking sim members for the isolated test
// environment. Needs/offers are designed to complement across types so
// complementary matching (offers ↔ needs) clearly fires:
//   cafes/venues need artists+musicians ↔ artists need walls/venues
//   organizers need vendors+performers ↔ vendors+artists need events
//   influencers offer audience ↔ vendors need coverage
// Lives only in `sim_members` + `sim-*` Pinecone namespaces — never real data.

const base = { city: "San Francisco", status: "claimed", source: "sim", seed: true, firstRecsMadeAt: "2026-01-01T00:00:00Z" };

export const SIM_MEMBERS = [
  // ── Vendors / venues ──
  { id: "sim_brewbloom", name: "Brew & Bloom Cafe", memberType: "vendor", neighborhood: "Mission", vibe: "cozy, plant-filled, community-first",
    businessDescription: "A neighborhood cafe with big blank walls and a weekend events corner.",
    offers: ["wall space for local artists", "free coffee for event hosts", "weekday-morning event space"],
    needs: ["local muralists for a rotating gallery", "acoustic musicians for weekend sets", "a pastry collaborator"] },
  { id: "sim_vinylvine", name: "Vinyl & Vine Wine Bar", memberType: "vendor", neighborhood: "Hayes Valley", vibe: "intimate, music-forward",
    businessDescription: "An evening wine bar with a great sound system and rotating wall art.",
    offers: ["evening venue for 40", "sound system", "wine for events"],
    needs: ["DJs and live jazz for weekends", "art for the walls", "a charcuterie vendor"] },
  { id: "sim_totones", name: "Totones Taqueria", memberType: "vendor", neighborhood: "Fruitvale", city: "Oakland", vibe: "lively, family-run",
    businessDescription: "Family taqueria that loves catering neighborhood events.",
    offers: ["taco catering for events", "late-night food for parties"],
    needs: ["festivals and pop-ups to cater", "influencer coverage"] },
  { id: "sim_greenthumb", name: "GreenThumb Nursery", memberType: "vendor", neighborhood: "Bernal Heights", vibe: "earthy, calm",
    businessDescription: "A plant nursery with a sunny patio perfect for workshops.",
    offers: ["workshop space among the plants", "plants and props for events"],
    needs: ["plant-care workshop instructors", "a florist partner for weddings"] },
  { id: "sim_knead", name: "Knead Bakery", memberType: "vendor", neighborhood: "Inner Sunset", vibe: "warm, early-morning",
    businessDescription: "A small-batch bakery looking to do breakfast pop-ups.",
    offers: ["pastries and bread for events", "early-morning pop-up space"],
    needs: ["a coffee partner for a breakfast pop-up", "a venue for a baking class"] },
  { id: "sim_saffron", name: "Saffron Indian Kitchen", memberType: "vendor", neighborhood: "Tenderloin", vibe: "fragrant, generous",
    businessDescription: "Regional Indian kitchen with a private dining room.",
    offers: ["catering for events", "a private dining room for 30"],
    needs: ["events to cater", "food-influencer coverage"] },
  { id: "sim_pedalpour", name: "Pedal Pour Coffee Cart", memberType: "vendor", neighborhood: "mobile", vibe: "bright, mobile",
    businessDescription: "A bike-powered espresso cart for events and markets.",
    offers: ["mobile coffee service for events"],
    needs: ["festivals and markets to serve", "a cafe to partner with on a pop-up"] },

  // ── Artists ──
  { id: "sim_maya", name: "Maya Rivera", memberType: "artist", discipline: "muralist", neighborhood: "Mission", vibe: "bold, community murals",
    businessDescription: "Muralist who turns blank cafe and shop walls into landmarks.",
    offers: ["live mural painting", "custom murals and hand-painted signage"],
    needs: ["walls and cafes to paint", "businesses to commission work"] },
  { id: "sim_solaris", name: "DJ Solaris", memberType: "artist", discipline: "DJ", neighborhood: "SoMa", vibe: "house & disco, warm sets",
    businessDescription: "DJ spinning house and disco for bars and warehouse parties.",
    offers: ["DJ sets (house, disco)", "a portable sound system"],
    needs: ["bars and wine venues for residencies", "warehouse and pop-up gigs"] },
  { id: "sim_foglight", name: "The Foglight Trio", memberType: "artist", discipline: "jazz trio", neighborhood: "North Beach", vibe: "mellow live jazz",
    businessDescription: "An acoustic jazz trio for relaxed weekend evenings.",
    offers: ["live acoustic jazz", "weekend background sets"],
    needs: ["wine bars and cafes for weekend slots"] },
  { id: "sim_clayco", name: "Clay & Co Ceramics", memberType: "artist", discipline: "ceramicist", neighborhood: "Dogpatch", vibe: "hands-on, craft",
    businessDescription: "A ceramics studio that loves teaching and selling at markets.",
    offers: ["pottery workshops", "handmade ceramics for markets"],
    needs: ["workshop venues", "market stalls and pop-ups"] },
  { id: "sim_lena", name: "Lena Park Photography", memberType: "artist", discipline: "photographer", neighborhood: "Outer Richmond", vibe: "natural-light, candid",
    businessDescription: "Event and product photographer for local makers.",
    offers: ["event photography", "product photography for vendors"],
    needs: ["events to shoot", "vendors needing catalog photos"] },
  { id: "sim_indigo", name: "Indigo Print Studio", memberType: "artist", discipline: "screen printer", neighborhood: "Bayview", vibe: "DIY, hands-on",
    businessDescription: "Screen-printing studio doing live printing at events.",
    offers: ["screen-printed merch for events", "a live printing station"],
    needs: ["events and festivals to print at", "bands needing merch"] },

  // ── Organizers ──
  { id: "sim_eastside", name: "Eastside Arts Collective", memberType: "organizer", cause: "neighborhood arts", neighborhood: "Fruitvale", city: "Oakland", vibe: "grassroots, vibrant",
    businessDescription: "A collective running monthly arts nights and a public-art day.",
    offers: ["an audience of 2k", "event promotion", "a community venue"],
    needs: ["local food vendors", "performers and DJs", "muralists for a public-art day"] },
  { id: "sim_nightmarket", name: "Night Market SF", memberType: "organizer", cause: "local commerce", neighborhood: "SoMa", vibe: "buzzy, high-traffic",
    businessDescription: "A recurring night market with heavy foot traffic.",
    offers: ["high-foot-traffic market slots", "marketing reach"],
    needs: ["food vendors", "craft and ceramic makers", "live music"] },
  { id: "sim_housingnow", name: "Housing Justice Now", memberType: "organizer", cause: "housing justice", neighborhood: "Tenderloin", vibe: "mission-driven",
    businessDescription: "Advocacy group hosting benefit shows to fund tenant support.",
    offers: ["a volunteer network", "press contacts"],
    needs: ["artists for a benefit show", "a venue to host", "caterers willing to donate"] },

  // ── Influencers ──
  { id: "sim_liachen", name: "Lia Chen — @sf.bites", memberType: "influencer", niche: "local food", neighborhood: "Mission", vibe: "warm foodie reels",
    businessDescription: "Food creator spotlighting SF restaurants and pop-ups.",
    offers: ["a 20k local-food audience", "event coverage and reels"],
    needs: ["restaurants and pop-ups to feature", "event partnerships"] },
  { id: "sim_marcuslee", name: "Marcus Lee — @oaklandmade", memberType: "influencer", niche: "local makers", neighborhood: "Temescal", city: "Oakland", vibe: "maker-scene champion",
    businessDescription: "Creator championing East Bay artisans and markets.",
    offers: ["a 15k maker-scene audience", "maker spotlights"],
    needs: ["artisans and ceramicists to feature", "market partnerships"] },
];

// Shape a seed entry into a flat profile like a real member doc.
export function simProfile(m) {
  const { id, ...rest } = m;
  return { ...base, ...rest };
}
