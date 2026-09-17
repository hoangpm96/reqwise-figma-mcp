actor user "User"
participant web "Web app" / browser
participant api "Booking API" / booking-svc
db db "Bookings DB" / postgres
external psp "Payment Gateway"
external mail "Email Service"
  user->>web: Select seats C5, C6
  web->>api: POST /showtimes/{id}/holds { seatIds }
  api->>db: SELECT booking_seats FOR UPDATE (showtime_id, seat_id)
  alt seats still free
    db-->>api: no live hold - seats free
    api->>db: INSERT bookings(status=held, hold_expires_at=now()+10min) + booking_seats
    db-->>api: bookingId
    api-->>web: 201 { bookingId, holdExpiresAt }
note: hold lasts 10 minutes
  else seats already booked
    db-->>api: seat C6 already held !err
    api-->>web: 409 seats_unavailable !err
  end
  user->>web: Confirm order, pay by credit card
  loop retry payment, up to 3 attempts
    web->>api: POST /bookings/{id}/payments { method: card }
    api->>db: INSERT payments(attempt_no=n, status=pending)
    db-->>api: paymentId
    api->>psp: POST /charges { amount, method, idempotency_key }
    note: timeout not specified
    alt payment succeeded
      psp-->>api: 200 { status: succeeded, txn_ref }
      api->>db: UPDATE payments=succeeded, bookings=paid
      db-->>api: committed
      api->>api: generate e-ticket + QR payload
      api--)mail: sendETicket(email, ticket, qr)
      api-->>web: 200 { ticketId, qrCode }
      web-->>user: Display the QR code
    else payment declined
      psp-->>api: 402 card_declined !err
      api->>db: UPDATE payments=failed
      db-->>api: committed
      api-->>web: 402 payment_failed (attempt n of 3) !err
      web-->>user: Show error, offer retry !err
    end
    break 3rd attempt used up - cancel and exit
      api->>db: UPDATE bookings=cancelled, DELETE booking_seats
      db-->>api: seats released
      api-->>web: 409 booking_cancelled !err
      web-->>user: Show "transaction cancelled" !err
    end
  end