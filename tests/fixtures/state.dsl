begin initial
held "Seats held"
  entry hold_expires_at = now() + 10 min
  detail booking_seats rows written
paying "Awaiting payment"
  do wait for the payment gateway
paid "Paid" final ok
  entry issue e-ticket + QR, email it
cancelled "Cancelled" final err
  entry release booking_seats
begin -> held: Reserve the selected seats / insert bookings + booking_seats
held -> paying: Confirm the order [payment method chosen] / insert payments(attempt_no, pending)
paying -> paid: Gateway: payment succeeded / generate e-ticket, send email, show QR !ok
paying ~> held: Gateway: payment declined [failed attempts < 3] !err
paying -> cancelled: Gateway: payment declined [failed attempts = 3] / release the reserved seats !err
