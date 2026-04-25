export const UPDATE_PROFILE_TOOL = {
  type: "function",
  function: {
    name: "update_profile",
    description: "Upsert profile fields the user just shared. Only include fields with new information from this turn.",
    parameters: {
      type: "object",
      properties: {
        memberType:             { type: "string", enum: ["vendor", "shopper", "artist", "organizer", "influencer"] },
        // vendor
        businessLink:           { type: "string" },
        businessDescription:    { type: "string" },
        approvedBlurb:          { type: "string" },
        shareTypes:             { type: "array", items: { type: "string" } },
        openToBusinessCollabs:  { type: "boolean" },
        // vendor + artist
        eventPlatforms:         { type: "array", items: { type: "string" } },
        // shopper
        interests:              { type: "array", items: { type: "string" } },
        neighborhood:           { type: "string" },
        personalNote:           { type: "string" },
        stayConnectedPreference:{ type: "string" },
        // artist
        discipline:             { type: "string" },
        venueTypes:             { type: "array", items: { type: "string" } },
        portfolioLink:          { type: "string" },
        city:                   { type: "string" },
        travelRadius:           { type: "string" },
        openToArtistCollabs:    { type: "boolean" },
        // organizer
        cause:                  { type: "string" },
        impactGoals:            { type: "array", items: { type: "string" } },
        connectWith:            { type: "array", items: { type: "string" } },
        orgLink:                { type: "string" },
        openToOtherCommunities: { type: "boolean" },
        // influencer
        niche:                  { type: "string" },
        platforms:              { type: "array", items: { type: "string" } },
        audienceSize:           { type: "string" },
        partnershipTypes:       { type: "array", items: { type: "string" } },
        profileLink:            { type: "string" },
        // meta
        onboardingComplete:     { type: "boolean" },
      },
    },
  },
};

export function extractProfileUpdate(completion) {
  const toolCalls = completion.choices[0]?.message?.tool_calls;
  if (!toolCalls?.length) return null;
  const call = toolCalls.find(t => t.function.name === "update_profile");
  if (!call) return null;
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    return null;
  }
}

export function getReply(completion) {
  return completion.choices[0]?.message?.content ?? "";
}
