# Agent rules

1. Read `.ai/BUILD_SPEC.md` before writing anything. It is the specification.
2. `.ai/AO_RUN.md` is the board and the handoff. Claim your stage there before
   your first edit and update it when you finish.
3. Money is an integer count of paise. Quantity is an integer count of
   thousandths of its unit. Rates are basis points. No float touches either,
   anywhere, ever.
4. Write tests as you go. Then break one line your tests should catch and prove
   the suite fails. A mutation that survives means the tests are wrong.
5. Keep every commit signed. Never add any agent as an author or co-author.
   Never alter commit dates.
6. Describe generated records as synthetic or simulated. Never imply synthetic
   data is real company data.
7. Keep credentials, personal details and raw company documents out of this
   repository.
8. Nothing in this system moves money. It prepares a file; a person sends it.
