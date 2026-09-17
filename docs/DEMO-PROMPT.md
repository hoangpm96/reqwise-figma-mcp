# Demo prompt

A ready-to-paste prompt that exercises every diagram kind in the free edition — userflow, activity with swimlanes, sequence, sitemap, state machine, ERD — plus mobile screens wired to the userflow. Use it to try the MCP end to end, or as a smoke test after an install or upgrade.

## Before you paste

1. Figma is open with the Reqwise plugin running, and `figma_status` reports connected (see [`SETUP.md`](./SETUP.md)).
2. The diagram skills are installed in `.claude/skills/` (see [Diagram skills](../README.md#diagram-skills)), so the agent can reach `/figma-userflow`, `/figma-activity`, `/figma-sequence`, `/figma-state`, `/figma-erd` and `/figma-sitemap`.
3. Start from an empty page — the demo draws a lot.

> **Free edition note.** "Build the component set first" works here as reusable, consistently named building-block frames — button, input, card, header — drawn on their own row before the screens. Real Figma components, variants and instances are a Pro feature.

The prompt tells the agent to invent any missing context (as long as it stays logical) and not to stop and ask for confirmation, which is what you want from an unattended demo.

## The prompt

```text
Using the Reqwise Figma MCP, produce a demo that showcases the diagram types available in the free edition, together with a set of illustrative mobile screens.

## Part 1 — Authentication userflow and screens

Design a reasonably complex authentication userflow for a mobile app covering:
- Log in (including failed attempts and error states)
- Sign up
- Forgot password
- A personal profile screen reached after a successful login, with a Log out action
- Set / change password

Deliverables:
1. Build the component set first (buttons, inputs, cards, headers, etc.) in a friendly, playful, "cute" mobile visual style.
2. Draw the userflow, with every decision branch and error path labelled.
3. Draw a mobile screen for every step and case in the userflow — none may be missing.
4. Connect each userflow node to its corresponding screen so every case can be traced from flow to UI.

## Part 2 — Diagrams for the movie-ticket booking flow

Using the user flow below, draw:
- An activity diagram with swimlanes
- A sequence diagram
- A state machine diagram
- An ERD
- A sitemap

The flow is intentionally non-trivial; each diagram should represent it in full.

## Assumptions

This is a demo. Where the brief is silent, invent any additional context, roles, data or sub-flows you need, as long as they are logical and consistent across all diagrams and screens. Do not stop to ask for confirmation — make reasonable decisions and proceed.

## User flow
- User visits the website and selects a movie.
- System displays available showtimes for the selected movie.
- User picks a showtime.
- System checks if the user is logged in:
  - If no, prompt user to log in with email and password.
  - If login fails, show error and allow retry.
  - If login succeeds, proceed.
- System shows the seating chart and available seats.
- User selects the number of seats and specific seat positions:
  - If seats are already booked, show "Seats unavailable" error and ask to reselect.
  - If seats are available, reserve them temporarily for 10 minutes.
- User confirms the order and chooses a payment method (credit card or e-wallet).
- System processes the payment:
  - If payment succeeds, generate an e-ticket, send it via email, and display a QR code.
  - If payment fails, show error and allow retry up to 3 times.
  - If retries exceed 3, cancel the transaction and release reserved seats.
- Process ends with the user receiving the ticket or the transaction being canceled.

## Requirements (activity diagram)
- Use swimlanes to represent roles involved, proposing them based on the process and user flow.
- Include a clear start point and ensure every path has a defined end point.
- Represent all key activities, decisions, and outcomes from the user flow.
- Add decision points with yes/no branches where applicable.
- Show data or interactions between swimlanes.
- Ensure logical and complete flow with no loose ends.
- Add notes to clarify complex steps if needed.
```

## What you should get

| Part | Built from | Look for |
|---|---|---|
| Authentication userflow | login, signup, forgot password, profile, logout, set password | Every decision has labelled branches; error paths return with dashed arrows |
| Component row | the cute mobile style | Buttons, inputs, cards and headers drawn once, before any screen |
| Mobile screens | one per userflow step | An arrow from each userflow node to its screen, error and empty states included |
| Activity diagram | the movie-ticket flow | Swimlanes such as User / Booking system / Payment gateway / Email service; one start, an end on every path |
| Sequence diagram | the movie-ticket flow | `alt` for login and payment outcomes, `loop` for the 3 payment retries |
| State machine | seat reservation or order | Held → Booked / Released with the 10-minute timeout and the retry limit as guards |
| ERD | the movie-ticket flow | Movie, Showtime, Seat, Reservation, Order, Payment, Ticket, User with crow's-foot cardinality |
| Sitemap | the movie-ticket product | The pages the userflow and screens actually use |

Each skill reports findings (dead ends, missing states, orphan pages) when it finishes — read them; they are part of the demo.
