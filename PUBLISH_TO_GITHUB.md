# Publish to GitHub and HACS

## 1. Replace the repository owner placeholder

From the extracted folder run:

```powershell
python .\tools\prepare_repository.py --owner grehell
```

## 2. Create the GitHub repository

Create a public repository:

```text
matrix-notification-center
```

Upload all files and folders from this package to the repository root.

Set:

```text
Description: Local advanced notification center for Home Assistant
Topics: home-assistant, hacs, notifications, custom-integration
```

Keep Issues enabled.

## 3. Check GitHub Actions

Both workflows should pass:

- Validate with HACS
- Validate with hassfest

## 4. Create a release

```text
Tag: v1.5.0
Title: Matrix Notification Center v1.5.0
```

## 5. Add the URL to HACS

Add the repository as a custom repository of type **Integration**.
