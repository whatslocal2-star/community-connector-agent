# Community Connector Agent — Master Topic Index

_Generated 2026-06-04 — 30 sessions_

---

## Architecture Decisions
- [DECISION] Assistant decided to update the system prompt in `chat.js` to include the artist flow and modify the initial greeting question. → {2026-04-25-c9a9a640.md}:Turn 12
- [DECISION] Assistant added a "Codebase Context Files" section to the global `CLAUDE.md`, establishing a rule to document findings in topic-focused `.md` files and to rewrite them upon revisiting the same area. → {2026-04-26-407da9bf.md}:Turn 3
- [DECISION] Assistant confirmed that `OVERVIEW.md` also suffers from the same issue as `.md` files and decided to consolidate all information into the project-level `CLAUDE.md`. → {2026-04-26-407da9bf.md}:Turn 7
- [DECISION] The assistant outlines the fixes implemented to address the identified issues, including creating a helper function to handle both strings and arrays, adjusting the location checks, and ensuring proper handling of field names in the shopper modal. → {2026-04-26-6c0b6e60.md}:Turn 31
- [DECISION] The assistant agrees to tighten the system prompt's guidance on data capture, emphasizing the need for concrete rules to ensure all relevant user information is recorded. → {2026-04-26-6c0b6e60.md}:Turn 33
- [DECISION] It was decided that when a user mentions posting on a platform like Instagram, the agent should confirm the specific channel and username instead of just acknowledging the statement. This ensures accurate data collection. → {2026-04-26-6c0b6e60.md}:Turn 42
- [DECISION] User and assistant agree on the architecture split: Community Connector for member intelligence, Mae Agent for campaign/workflow engine, and Social Listener as a new service. The first move is to upgrade the Community Connector from JSON mode to a real tool that can dispatch actions. → {2026-04-29-59e641f5.md}:Turn 8
- [DECISION] Assistant presents three options for integrating tasks into Linear: adding Linear MCP for long-term use, using the Linear API directly with an API key, or providing a formatted issue list for manual entry. User must choose one option. → {2026-04-29-eb1394ad.md}:Turn 6
- [DECISION] Assistant advises against using WorkOS and Clerk for authentication, stating that Supabase auth already meets the project's needs and would require unnecessary migration efforts. → {2026-04-29-eb1394ad.md}:Turn 20
- [DECISION] Assistant outlines the components for the integration: a `syncToProlocaliq.js` library, a new integration endpoint in ProLocalIQ, an updated system prompt to collect email, and hooks into `chat.js` and `sms.js`. → {2026-04-30-7fb52a35.md}:Turn 8
- [DECISION] User requests to keep all marketplace-related work in a separate branch to maintain cleanliness in the repository. → {2026-05-19-1ad177dc.md}:Turn 13
- [DECISION] Assistant proposes a clean approach to create a new branch `feat/commerce-layer` at the current HEAD and reset the local `main` to match the remote, ensuring the commerce commits are safely isolated. → {2026-05-19-1ad177dc.md}:Turn 14
- [DECISION] Assistant confirmed that both Sentry and PostHog should be used for the app, with Sentry for error tracking and PostHog for product metrics related to the agent's performance. → {2026-05-18-b046ba19.md}:Turn 17
- [DECISION] Assistant suggested a refactor to create a shared function `processTurn(memberId, incomingText, history, options)` to eliminate redundancy between `sms.js` and `chat.js`. → {2026-06-04-b86d1bc5.md}:Turn 15

## Features
- [TASK] User requested to add an artist flow for matching them with venues and events. → {2026-04-25-c9a9a640.md}:Turn 8
- [TASK] User requested to add community organizers to help them connect with others and make an impact. → {2026-04-25-c9a9a640.md}:Turn 19
- [TASK] User requested to add influencers to connect them with businesses for social media partnerships. → {2026-04-25-c9a9a640.md}:Turn 23
- [TASK] User requested to enable communities to discover each other and for shoppers to connect with nearby people through notes and interests. → {2026-04-25-c9a9a640.md}:Turn 25
- [TASK] User requested to enhance the vendor setup by asking for unique descriptions and event posting preferences. → {2026-04-25-c9a9a640.md}:Turn 28
- [TASK] The assistant begins writing the admin API function and the dashboard page in parallel. → {2026-04-25-c9a9a640.md}:Turn 93
- [TASK] The assistant reviews the current modal code to identify what is missing. → {2026-04-25-c9a9a640.md}:Turn 113
- [TASK] The assistant replaces the modal styles and the entire `openModal` / `buildProfileHtml` block. → {2026-04-25-c9a9a640.md}:Turn 115
- [TASK] The assistant deploys and commits the changes. → {2026-04-25-c9a9a640.md}:Turn 118
- [TASK] User instructed to update global instructions to store context from codebase explorations in appropriate `.md` files in the app's root directory, ensuring that the files are rewritten rather than appended to keep them up to date. → {2026-04-26-407da9bf.md}:Turn 1
- [TASK] Assistant plans to update the examples in the system prompt to reinforce the new rules regarding merging data and maintaining a flat schema. → {2026-04-26-6c0b6e60.md}:Turn 40
- [TASK] Assistant updated the instructions to drop `OVERVIEW.md`, consolidate everything into the project `CLAUDE.md`, and ensure that the file is rewritten rather than appended to prevent it from becoming a stale log. → {2026-04-26-407da9bf.md}:Turn 8
- [TASK] User requests to merge the community connector agent with the LocalLoop project, emphasizing the need for the agent to reside there and to merge credentials from phone numbers and emails for the same user. → {2026-04-29-eb1394ad.md}:Turn 16
- [TASK] Assistant outlines the specific tasks to be completed for merging the agent with LocalLoop, including adding CORS to `chat.js`, creating a `link-identity.js` function, and modifying onboarding and assistant components. → {2026-04-29-eb1394ad.md}:Turn 26
- [TASK] User requests integration of account creation, onboarding, and product addition in the ProLocalIQ app/server, which should reflect in the LocalLoop native app. → {2026-04-30-7fb52a35.md}:Turn 1
- [TASK] User requested to add `multiagent_mae` functionality into the community-connector agent app and subsequently into the prolocaliq server. → {2026-04-30-c5fa70ec.md}:Turn 1
- [TASK] User identified the need to connect the current project to the mae_agent system. → {2026-04-30-e0c13a67.md}:Turn 1
- [TASK] Assistant updates the admin modal to include a "Conversation" tab. → {2026-05-05-293136b7.md}:Turn 8
- [TASK] Assistant modifies the JavaScript to fix the `openModal` function, add a `switchTab` function, and implement conversation loading. → {2026-05-05-293136b7.md}:Turn 10
- [TASK] Assistant adds the `switchTab` and `loadConversation` functions before the `findMatches` function in the code. → {2026-05-05-293136b7.md}:Turn 11
- [TASK] User requested to check if the structured search feature is working as described in the manifesto and to identify any necessary actions if it is not. → {2026-05-18-611e790d.md}:Turn 1
- [TASK] User specified to check the structured search feature on desktop specifically. → {2026-05-18-611e790d.md}:Turn 2
- [TASK] User instructed to implement changes in a separate new branch. → {2026-05-18-611e790d.md}:Turn 4
- [TASK] Assistant began wiring price parsing and normalization into the chat post-save process. → {2026-05-18-611e790d.md}:Turn 8
- [TASK] Assistant expanded `searchIntent.js` with new filter keys to accommodate the structured search requirements. → {2026-05-18-611e790d.md}:Turn 9
- [TASK] Assistant rewrote `search.js` to integrate filters into Pinecone metadata and added product-level pricing logic along with transparency for matched results. → {2026-05-18-611e790d.md}:Turn 10
- [TASK] Assistant created a backfill endpoint for existing members to parse and normalize pricing data and re-embed it for Pinecone metadata. → {2026-05-18-611e790d.md}:Turn 11
- [TASK] Assistant decided to wire the same price parsing normalization into the SMS path for consistency. → {2026-05-18-611e790d.md}:Turn 12
- [TASK] User requests an update to the markdown documentation. → {2026-04-25-c9a9a640.md}:Turn 110
- [TASK] The user requests another update to the markdown documentation. → {2026-04-25-c9a9a640.md}:Turn 120
- [TASK] User instructed to implement the plan on a new branch and to commit changes after completing each phase. → {2026-05-19-f8ca10a5.md}:Turn 17
- [TASK] Fix the vendor dashboard to ensure it retrieves the user's first name and email correctly, addressing the blank values issue. → {2026-05-19-f8ca10a5.md}:Turn 60
- [TASK] Update the sign-in page to remove the deprecated `routing="hash"` attribute. → {2026-05-19-f8ca10a5.md}:Turn 61
- [TASK] Update local CLAUDE.md files and prepare instructions for continuing the project in a new session. → {2026-05-19-f8ca10a5.md}:Turn 68

## Bugs
- [BUG] An empty reply indicates the model made a tool call but returned no text content. The assistant will check Firestore for data and fix the empty reply issue. → {2026-04-25-c9a9a640.md}:Turn 82
- [BUG] The user reports not seeing data added to Firestore or displayed on the admin page. → {2026-04-25-c9a9a640.md}:Turn 97
- [BUG] The assistant discovers that Firestore is not writing due to an error being hidden by the `.catch` statement. The assistant will check the Netlify function logs. → {2026-04-25-c9a9a640.md}:Turn 99
- [BUG] The assistant identifies the real bug: data is being written with literal dot-named keys instead of a nested `profile` object. The assistant plans to fix `db.js` and the `loadAllMembers` history strip. → {2026-04-25-c9a9a640.md}:Turn 102
- [BUG] The user reports that the admin panel is not loading all users correctly, particularly for the Shopper member type. → {2026-04-26-6c0b6e60.md}:Turn 20
- [BUG] Assistant finds that `chat.js` does not save conversation history to Firestore, managing it only client-side. → {2026-05-05-293136b7.md}:Turn 16
- [BUG] Assistant discovers that the web chat functionality does not persist history to Firestore, unlike SMS members, and decides to fix `chat.js` to save conversation history after each turn. → {2026-05-05-293136b7.md}:Turn 17
- [BUG] Assistant identified a version mismatch with the Trigger.dev CLI, needing to use the v3 CLI to match the SDK version. → {2026-05-18-faf6b76e.md}:Turn 46
- [BUG] Assistant encountered a "Project not found" error for the specified reference under the user's account, indicating a potential misconfiguration or missing project. → {2026-05-18-faf6b76e.md}:Turn 49
- [BUG] Assistant reported that the Netlify function timed out due to exceeding the function limit, deciding to run the backfill locally against the production Firestore and Pinecone. → {2026-05-18-611e790d.md}:Turn 115
- [BUG] Assistant discovered that the `MemberCard` component is using a hardcoded lookup table for images instead of the correct `profile.imageUrl`, which is causing missing images in the UI. → {2026-05-18-611e790d.md}:Turn 151
- [BUG] Diagnosed the 500 errors as a result of Firestore quota exhaustion due to excessive reads during the session. Confirmed that the code improvements would
