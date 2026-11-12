This directory contains the results of my ham-fisted exploration of the iOS 27 issue. (See https://moodeaudio.org/forum/showthread.php?tid=9041&pid=75497#pid75497 and the related https://github.com/moode-player/moode/issues/844)

In this exercise, I probed the moOde codebase using opencode connected with DeepSeek V4.1 Flash Free and followed its suggestions to test various hypotheses. The exercise is best described as a drunkard's walk with these tools resulting in thousands of lines of reasoning and numerous explorations of alternatives. You're seeing only the last mile of the journey.

This directory contains truncated versions of the final two opencode session transcripts, which I've named webkit-diag.md and dashboard-diag.md, as well as the modified www/js/links.js file they suggested.

The initial commit of the links.js file contains the modification described in webkit-diag.md. That modification "fixed" the original iOS 27 issue, e.g., the apparent immediate closure of m>Configure and m>Power after opening on my Apple devices (actually, it was mobile WebKit reloading the page). However, testing with this modified links.js file uncovered a new problem. Selecting m>Dashboard or m>Audio info had become a no-op.

The diagnosis of this new problem is summarized in dashboard-diag.md and the current version of the links.js file repairs it.

**The result**

Replacing the original version of www/js/links.js in the moOde repo with this latest modified version and using gulp to rebuild and deploy the result, I now have a moOde 10.3.7 player whose webUI apparently behaves correctly in browsers on my iPad (iPadOS 27.2.1) and my iPhone (iOS 27.2.1) and continues to behave correctly in browsers on my Android phone and Linux host. Specifically, the m>Configure modal and m>Power modals no longer immediately close (actually, it was the page reloading) after opening when clicked on my Apple devices. As well, all the other "m" menu items are working again.

Note that the transcripts make several references to the results of tests I performed. I have chosen not to report the details here.

DISCLAIMER: I am not now and never have been a JavaScript jockey. Unaided, I could not possibly fight my way through the code which implements the moOde webUI. I do not claim I know opencode/DeepSeek are correctly fixing the iOS 27 issue but I believe this exercise may help the real moOde developer(s) do so.
