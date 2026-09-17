users happy
  id uuid pk!
  email varchar(255)!
  password_hash text!
  full_name text
  created_at timestamptz!
movies edge
  id uuid pk!
  title text!
  duration_min int!
  rating text
cinemas edge
  id uuid pk!
  name text!
  city text!
auditoriums edge
  id uuid pk!
  cinema_id uuid fk!
  name text!
seats edge / the seating chart
  id uuid pk!
  auditorium_id uuid fk!
  row_label varchar(4)!
  seat_number int!
  seat_class text
showtimes happy
  id uuid pk!
  movie_id uuid fk!
  auditorium_id uuid fk!
  starts_at timestamptz!
  base_price numeric(12,2)!
  status text!
bookings happy / the order
  id uuid pk!
  user_id uuid fk!
  showtime_id uuid fk!
  status text!
  hold_expires_at timestamptz
  total_amount numeric(12,2)!
  created_at timestamptz!
booking_seats happy / one row per seat held
  booking_id uuid pfk!
  seat_id uuid pfk!
  showtime_id uuid fk!
  price numeric(12,2)!
payments / one row per attempt
  id uuid pk!
  booking_id uuid fk!
  method text!
  amount numeric(12,2)!
  status text!
  attempt_no int!
  provider_ref varchar(64)
  created_at timestamptz!
tickets / the e-ticket
  id uuid pk!
  booking_id uuid fk!
  qr_payload text!
  issued_at timestamptz!
  email_sent_at timestamptz
psp_transactions ext / payment gateway
  reference varchar(64)!
  status text!
  amount numeric(12,2)!
cinemas.id 1-* auditoriums.cinema_id "has"
auditoriums.id 1-+ seats.auditorium_id "is laid out as"
movies.id 1-* showtimes.movie_id "is screened at"
auditoriums.id 1-* showtimes.auditorium_id "hosts"
users.id 1-* bookings.user_id "books"
showtimes.id 1-* bookings.showtime_id "is booked by"
bookings.id 1=+ booking_seats.booking_id "holds"
seats.id 1-* booking_seats.seat_id "is held by"
showtimes.id 1-* booking_seats.showtime_id "guards double-booking"
bookings.id 1-* payments.booking_id "is paid by"
bookings.id 1-? tickets.booking_id "produces"
payments.provider_ref 1-? psp_transactions.reference "settled as"
