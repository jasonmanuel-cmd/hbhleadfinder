-- 004: trigger functions are not callable via the public API
revoke execute on function guard_outreach()   from public, anon, authenticated;
revoke execute on function guard_deal_stage() from public, anon, authenticated;
