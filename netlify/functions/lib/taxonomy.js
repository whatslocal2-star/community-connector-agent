export const TAXONOMY = {
  vendor: {
    "Food & Beverage": ["Restaurant", "Café", "Bakery", "Food Truck", "Bar", "Catering", "Juice Bar", "Desserts"],
    "Retail": ["Clothing", "Accessories", "Beauty & Cosmetics", "Home Goods", "Books", "Flowers", "Gifts"],
    "Health & Wellness": ["Gym", "Yoga Studio", "Spa", "Salon", "Nutrition", "Massage", "Mental Health"],
    "Services": ["Photography", "Videography", "Cleaning", "Auto", "Printing", "Event Rental", "Consulting"],
    "Arts & Crafts": ["Gallery", "Jewelry", "Pottery", "Handmade Goods", "Candles", "Textiles", "Murals"],
  },
  artist: {
    "Music": ["DJ", "Band", "Singer", "Musician", "Producer", "Rapper", "Classical"],
    "Visual Arts": ["Painter", "Illustrator", "Photographer", "Graphic Designer", "Muralist", "Sculptor"],
    "Performance": ["Comedian", "Actor", "Dancer", "Spoken Word", "Poet", "Circus", "Magician"],
    "Digital": ["Videographer", "Animator", "Motion Designer", "Content Creator"],
  },
  organizer: {
    "Community": ["Neighborhood", "Cultural", "Youth", "Seniors", "LGBTQ+", "Faith-Based"],
    "Cause": ["Social Justice", "Environment", "Housing", "Health", "Education", "Food Security"],
    "Events": ["Festival", "Market", "Concert", "Sports", "Food Event", "Art Show"],
  },
  shopper: {
    "Lifestyle": ["Fashion", "Home & Living", "Tech", "Outdoor & Adventure"],
    "Food & Dining": ["Foodie", "Vegan", "Health Food", "Local Produce", "Fine Dining"],
    "Entertainment": ["Music", "Art", "Sports", "Nightlife", "Gaming"],
    "Wellness": ["Fitness", "Beauty", "Mental Health", "Alternative Health"],
  },
  influencer: {
    "Lifestyle": ["Fashion", "Travel", "Home Decor", "Parenting", "Luxury"],
    "Food": ["Restaurant Reviews", "Home Cooking", "Vegan", "Street Food", "Cocktails"],
    "Fitness & Wellness": ["Gym", "Yoga", "Nutrition", "Mental Health", "Outdoor"],
    "Entertainment": ["Music", "Comedy", "Gaming", "Local Culture", "Events"],
    "Local": ["Neighborhood Guide", "Local Events", "Community Stories", "Hidden Gems"],
  },
};

export const TAXONOMY_PROMPT = `
CATEGORY & SUBCATEGORY — once memberType is known, assign the best-fit category and subcategory from this taxonomy. Store as "category" and "subcategory" (strings). Use exact names from the list. If nothing fits exactly, use the closest match.

vendor: Food & Beverage (Restaurant, Café, Bakery, Food Truck, Bar, Catering, Juice Bar, Desserts) | Retail (Clothing, Accessories, Beauty & Cosmetics, Home Goods, Books, Flowers, Gifts) | Health & Wellness (Gym, Yoga Studio, Spa, Salon, Nutrition, Massage, Mental Health) | Services (Photography, Videography, Cleaning, Auto, Printing, Event Rental, Consulting) | Arts & Crafts (Gallery, Jewelry, Pottery, Handmade Goods, Candles, Textiles, Murals)
artist: Music (DJ, Band, Singer, Musician, Producer, Rapper, Classical) | Visual Arts (Painter, Illustrator, Photographer, Graphic Designer, Muralist, Sculptor) | Performance (Comedian, Actor, Dancer, Spoken Word, Poet, Circus, Magician) | Digital (Videographer, Animator, Motion Designer, Content Creator)
organizer: Community (Neighborhood, Cultural, Youth, Seniors, LGBTQ+, Faith-Based) | Cause (Social Justice, Environment, Housing, Health, Education, Food Security) | Events (Festival, Market, Concert, Sports, Food Event, Art Show)
shopper: Lifestyle (Fashion, Home & Living, Tech, Outdoor & Adventure) | Food & Dining (Foodie, Vegan, Health Food, Local Produce, Fine Dining) | Entertainment (Music, Art, Sports, Nightlife, Gaming) | Wellness (Fitness, Beauty, Mental Health, Alternative Health)
influencer: Lifestyle (Fashion, Travel, Home Decor, Parenting, Luxury) | Food (Restaurant Reviews, Home Cooking, Vegan, Street Food, Cocktails) | Fitness & Wellness (Gym, Yoga, Nutrition, Mental Health, Outdoor) | Entertainment (Music, Comedy, Gaming, Local Culture, Events) | Local (Neighborhood Guide, Local Events, Community Stories, Hidden Gems)
`.trim();
