# Git Remote Configuration

## Website Repository Remote

The `website` remote has been configured to use SSH authentication as requested:

```bash
$ git remote -v
origin   https://github.com/dobutsustationery/admin (fetch)
origin   https://github.com/dobutsustationery/admin (push)
website  git@github.com:dobutsustationery/website.git (fetch)
website  git@github.com:dobutsustationery/website.git (push)
```

## Current Status

The remote is configured, but SSH connections are timing out in the GitHub Actions environment:

- **Port 22 (default SSH)**: Connection timed out
- **Port 443 (alternative)**: Connection timed out  
- **SSH Keys**: Not configured in the environment

### Error Message
```
ssh: connect to host github.com port 22: Connection timed out
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
```

## To Complete the Import

Once SSH authentication is properly configured (deploy keys, SSH agent, etc.), run:

```bash
git fetch website admin-site
git checkout -b admin-site-review FETCH_HEAD
git log --oneline
# Then merge or cherry-pick commits as needed
```

## Alternative: HTTPS with Token

If SSH continues to have issues, HTTPS with a GitHub token that has access to both repositories would also work:

```bash
git remote set-url website https://github.com/dobutsustationery/website.git
# Ensure GITHUB_TOKEN or similar has read access to the website repository
git fetch website admin-site
```
