# Testing Strategies Skill

Apply these testing strategies to ensure code reliability:

## Testing Pyramid

### Unit Tests (70%)
- Test pure functions and business logic in isolation
- Fast execution (under 10ms per test)
- Mock external dependencies; test only the unit's behavior
- Use descriptive test names: `should return empty array when no items match filter`

### Integration Tests (20%)
- Test component interactions: API routes, database queries, service calls
- Use real dependencies where practical (test databases, in-memory stores)
- Test the contract between modules, not internal implementation
- Cover authentication, authorization, and data validation flows

### End-to-End Tests (10%)
- Test critical user journeys: signup, purchase, data export
- Run against a production-like environment
- Keep the suite small and focused on high-value paths
- Accept slower execution; optimize for reliability over speed

## Test Design Patterns

### Arrange-Act-Assert (AAA)
```
// Arrange: set up test data and dependencies
// Act: execute the function under test
// Assert: verify the result matches expectations
```

### Test Naming
- Describe the scenario: `when user has no permissions`
- State the expected outcome: `should return 403 forbidden`
- Full: `when user has no permissions, should return 403 forbidden`

### What to Test
- Happy path: normal expected usage
- Edge cases: empty inputs, boundary values, max sizes
- Error cases: invalid input, network failures, timeouts
- Security: unauthorized access, injection attempts

### What Not to Test
- Implementation details (private methods, internal state)
- Third-party library behavior
- Trivial getters/setters without logic
- Generated code
