# The IA of a small CRM. Indentation is containment: a page indented under
# another LIVES under it. No arrows anywhere — where the user goes next is a
# userflow, and a different diagram.
crm "CRM"
  dash "Dashboard" screen:dashboard
  contacts "Liên hệ"
    list "Danh sách liên hệ" screen:contacts-list
    detail "Chi tiết liên hệ" screen:contact-detail / chỉ chủ sở hữu và quản lý xem được
    importer "Nhập từ CSV" screen:contacts-import
  deals "Cơ hội"
    board "Bảng kanban" screen:deals-board
    lost "Đã mất" edge
  reports "Báo cáo" section
    revenue "Doanh thu"
    activity "Hoạt động nhân viên"
  settings "Cài đặt"
    team "Thành viên"
    billing "Thanh toán"
      psp "Cổng thanh toán" external
    delete "Xoá workspace" modal err
