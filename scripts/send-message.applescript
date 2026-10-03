-- Usage: osascript send-message.applescript <recipient> <text> <iMessage|SMS>
-- The first run prompts macOS to allow Terminal/node to control Messages (System Settings > Privacy & Security > Automation).
on run argv
	set theTo to item 1 of argv
	set theText to item 2 of argv
	set theType to item 3 of argv
	tell application "Messages"
		if theType is "SMS" then
			set targetService to 1st account whose service type = SMS
		else
			set targetService to 1st account whose service type = iMessage
		end if
		set targetBuddy to participant theTo of targetService
		send theText to targetBuddy
	end tell
end run
