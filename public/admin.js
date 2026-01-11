// Configuration
let adminToken = localStorage.getItem('maxmovies_admin_token');
let apiBaseUrl = localStorage.getItem('maxmovies_api_url') || 'https://your-api.vercel.app';
let currentPage = 1;
let usersPerPage = 10;
let allUsers = [];

// DOM Elements
const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const adminTokenInput = document.getElementById('adminToken');
const apiUrlInput = document.getElementById('apiUrl');
const statusIndicator = document.getElementById('statusIndicator');
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');

// Initialize
function init() {
    checkAuth();
    setupEventListeners();
    updateStatusIndicator();
}

// Check authentication
function checkAuth() {
    if (adminToken && adminToken.length > 10) {
        loginScreen.style.display = 'none';
        dashboard.style.display = 'flex';
        loadInitialData();
    } else {
        loginScreen.style.display = 'flex';
        dashboard.style.display = 'none';
    }
}

// Setup event listeners
function setupEventListeners() {
    // Enter key for login
    adminTokenInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') login();
    });
    
    apiUrlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') login();
    });
    
    // Auto-update status every 30 seconds
    setInterval(updateStatusIndicator, 30000);
}

// Login function
async function login() {
    const token = adminTokenInput.value.trim();
    const url = apiUrlInput.value.trim();
    
    if (!token) {
        alert('Please enter admin token');
        return;
    }
    
    if (!url.startsWith('http')) {
        alert('Please enter a valid URL starting with http:// or https://');
        return;
    }
    
    try {
        showLoading();
        
        // Test connection
        const response = await fetch(`${url}/api/admin?action=health`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            throw new Error('Authentication failed');
        }
        
        // Save credentials
        adminToken = token;
        apiBaseUrl = url;
        
        localStorage.setItem('maxmovies_admin_token', token);
        localStorage.setItem('maxmovies_api_url', url);
        
        // Show dashboard
        loginScreen.style.display = 'none';
        dashboard.style.display = 'flex';
        
        // Load initial data
        await loadInitialData();
        
    } catch (error) {
        alert(`Login failed: ${error.message}`);
        console.error('Login error:', error);
    } finally {
        hideLoading();
    }
}

// Logout function
function logout() {
    if (confirm('Are you sure you want to logout?')) {
        localStorage.removeItem('maxmovies_admin_token');
        localStorage.removeItem('maxmovies_api_url');
        adminToken = null;
        apiBaseUrl = null;
        loginScreen.style.display = 'flex';
        dashboard.style.display = 'none';
        adminTokenInput.value = '';
    }
}

// Toggle token visibility
function toggleTokenVisibility() {
    const eyeIcon = document.getElementById('eyeIcon');
    if (adminTokenInput.type === 'password') {
        adminTokenInput.type = 'text';
        eyeIcon.className = 'fas fa-eye-slash';
    } else {
        adminTokenInput.type = 'password';
        eyeIcon.className = 'fas fa-eye';
    }
}

// Update status indicator
async function updateStatusIndicator() {
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=health`);
        const data = await response.json();
        
        if (data.status === 'ok') {
            statusDot.className = 'status-dot connected';
            statusText.textContent = 'Connected';
            statusIndicator.title = `Last checked: ${new Date().toLocaleTimeString()}`;
        } else {
            statusDot.className = 'status-dot';
            statusText.textContent = 'Disconnected';
        }
    } catch (error) {
        statusDot.className = 'status-dot';
        statusText.textContent = 'Disconnected';
    }
}

// Load initial data
async function loadInitialData() {
    try {
        await Promise.all([
            loadStats(),
            loadUsers(),
            loadSystemStats()
        ]);
    } catch (error) {
        console.error('Failed to load initial data:', error);
    }
}

// Load system statistics
async function loadStats() {
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=stats`, {
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to load stats');
        
        const data = await response.json();
        
        // Update quick stats
        document.getElementById('totalUsers').textContent = data.memory?.count || 0;
        document.getElementById('quickUserCount').textContent = data.memory?.count || 0;
        document.getElementById('quickOnline').textContent = Math.floor(Math.random() * 10); // Mock
        
        // Update memory usage
        const memoryMB = Math.round((data.memory?.size || 0) / 1024 / 1024);
        document.getElementById('memoryUsage').textContent = `${memoryMB} MB`;
        
        // Update rate limits
        document.getElementById('rateLimitFiles').textContent = data.rateLimits?.count || 0;
        
        // Load activity
        await loadActivity();
        
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Load users
async function loadUsers() {
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=users&limit=1000`, {
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to load users');
        
        const data = await response.json();
        allUsers = data.users || [];
        
        displayUsers();
        
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

// Display users in table
function displayUsers() {
    const startIndex = (currentPage - 1) * usersPerPage;
    const endIndex = startIndex + usersPerPage;
    const usersToShow = allUsers.slice(startIndex, endIndex);
    
    const usersTable = document.getElementById('usersTable');
    usersTable.innerHTML = '';
    
    if (usersToShow.length === 0) {
        usersTable.innerHTML = `
            <tr>
                <td colspan="6" class="text-center">No users found</td>
            </tr>
        `;
        return;
    }
    
    usersToShow.forEach(user => {
        const row = document.createElement('tr');
        
        const lastActive = user.lastActive 
            ? new Date(user.lastActive).toLocaleString()
            : 'Never';
        
        row.innerHTML = `
            <td><code>${user.userId}</code></td>
            <td>${lastActive}</td>
            <td>${user.conversationLength || 0}</td>
            <td>${user.lastProject || 'N/A'}</td>
            <td>${formatBytes(user.memorySize || 0)}</td>
            <td>
                <button class="btn btn-sm" onclick="viewUserDetails('${user.userId}')">
                    <i class="fas fa-eye"></i>
                </button>
                <button class="btn btn-sm btn-danger" onclick="deleteUserMemory('${user.userId}')">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        
        usersTable.appendChild(row);
    });
    
    updatePagination();
}

// Update pagination controls
function updatePagination() {
    const totalPages = Math.ceil(allUsers.length / usersPerPage);
    document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
    
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage === totalPages || totalPages === 0;
}

// Next page
function nextPage() {
    const totalPages = Math.ceil(allUsers.length / usersPerPage);
    if (currentPage < totalPages) {
        currentPage++;
        displayUsers();
    }
}

// Previous page
function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        displayUsers();
    }
}

// Search users
function searchUsers() {
    const searchTerm = document.getElementById('userSearch').value.toLowerCase();
    
    if (!searchTerm) {
        loadUsers();
        return;
    }
    
    const filteredUsers = allUsers.filter(user => 
        user.userId.toLowerCase().includes(searchTerm) ||
        (user.lastProject && user.lastProject.toLowerCase().includes(searchTerm))
    );
    
    allUsers = filteredUsers;
    currentPage = 1;
    displayUsers();
}

// Load activity
async function loadActivity() {
    const activityTable = document.getElementById('activityTable');
    activityTable.innerHTML = '<tr><td colspan="5" class="text-center">Loading...</td></tr>';
    
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=users&limit=10`, {
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to load activity');
        
        const data = await response.json();
        const users = data.users || [];
        
        activityTable.innerHTML = '';
        
        users.forEach(user => {
            const row = document.createElement('tr');
            
            const lastActive = user.lastActive 
                ? new Date(user.lastActive).toLocaleString()
                : 'Never';
            
            row.innerHTML = `
                <td><code>${user.userId.substring(0, 8)}...</code></td>
                <td>${lastActive}</td>
                <td>${user.lastProject || 'N/A'}</td>
                <td>${user.conversationLength || 0}</td>
                <td>
                    <button class="btn btn-sm" onclick="viewUserDetails('${user.userId}')">
                        View
                    </button>
                </td>
            `;
            
            activityTable.appendChild(row);
        });
        
    } catch (error) {
        console.error('Error loading activity:', error);
        activityTable.innerHTML = `
            <tr>
                <td colspan="5" class="text-center">Failed to load activity</td>
            </tr>
        `;
    }
}

// Refresh activity
function refreshActivity() {
    loadActivity();
}

// View user details
async function viewUserDetails(userId) {
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=user&userId=${encodeURIComponent(userId)}`, {
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to load user details');
        
        const data = await response.json();
        
        if (data.error) {
            alert(`Error: ${data.error}`);
            return;
        }
        
        document.getElementById('modalTitle').textContent = `User: ${userId}`;
        
        let html = `
            <div class="user-details">
                <div class="detail-item">
                    <strong>User ID:</strong> ${data.userId}
                </div>
                <div class="detail-item">
                    <strong>Last Modified:</strong> ${new Date(data.lastModified).toLocaleString()}
                </div>
                
                <h4>Memory Information</h4>
                <div class="detail-item">
                    <strong>Last Project:</strong> ${data.memory?.lastProject || 'N/A'}
                </div>
                <div class="detail-item">
                    <strong>Last Task:</strong> ${data.memory?.lastTask || 'N/A'}
                </div>
                <div class="detail-item">
                    <strong>Conversation Length:</strong> ${data.memory?.conversationLength || 0}
                </div>
                
                <h4>Recent Messages</h4>
        `;
        
        if (data.memory?.firstMessages && data.memory.firstMessages.length > 0) {
            html += '<ul class="message-list">';
            data.memory.firstMessages.forEach(msg => {
                html += `<li>${escapeHtml(msg)}...</li>`;
            });
            html += '</ul>';
        } else {
            html += '<p>No messages found</p>';
        }
        
        html += `
                <div class="detail-actions">
                    <button class="btn btn-danger" onclick="deleteUserMemory('${userId}', true)">
                        Delete User Memory
                    </button>
                </div>
            </div>
        `;
        
        document.getElementById('modalBody').innerHTML = html;
        document.getElementById('userModal').style.display = 'flex';
        
    } catch (error) {
        console.error('Error loading user details:', error);
        alert(`Failed to load user details: ${error.message}`);
    }
}

// Delete user memory
async function deleteUserMemory(userId, fromModal = false) {
    if (!confirm(`Are you sure you want to delete memory for user "${userId}"? This action cannot be undone.`)) {
        return;
    }
    
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=delete&userId=${encodeURIComponent(userId)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to delete user memory');
        
        const data = await response.json();
        
        if (data.success) {
            alert('User memory deleted successfully');
            
            if (fromModal) {
                closeModal();
            }
            
            // Refresh data
            await loadStats();
            await loadUsers();
            
        } else {
            alert(`Error: ${data.error || 'Unknown error'}`);
        }
        
    } catch (error) {
        console.error('Error deleting user memory:', error);
        alert(`Failed to delete user memory: ${error.message}`);
    }
}

// Clear all memory
async function clearAllMemory() {
    if (!confirm('⚠️ DANGER: This will delete ALL user memory and rate limit data. Are you absolutely sure?')) {
        return;
    }
    
    if (!confirm('This action is irreversible. Type "DELETE ALL" to confirm:')) {
        return;
    }
    
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=clearAll`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminToken}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) throw new Error('Failed to clear all memory');
        
        const data = await response.json();
        
        if (data.success) {
            alert('All memory cleared successfully');
            
            // Refresh data
            await loadStats();
            await loadUsers();
            
        } else {
            alert(`Error: ${data.error || 'Unknown error'}`);
        }
        
    } catch (error) {
        console.error('Error clearing all memory:', error);
        alert(`Failed to clear all memory: ${error.message}`);
    }
}

// Load system stats
async function loadSystemStats() {
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=stats`, {
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to load system stats');
        
        const data = await response.json();
        
        // Update system info
        document.getElementById('systemUptime').textContent = `${Math.floor(data.system?.uptime || 0)}s`;
        document.getElementById('nodeVersion').textContent = data.system?.nodeVersion || 'Unknown';
        
        if (data.system?.memoryUsage) {
            const mem = data.system.memoryUsage;
            document.getElementById('heapUsed').textContent = `${Math.round(mem.heapUsed / 1024 / 1024)} MB`;
            document.getElementById('heapTotal').textContent = `${Math.round(mem.heapTotal / 1024 / 1024)} MB`;
            document.getElementById('rssMemory').textContent = `${Math.round(mem.rss / 1024 / 1024)} MB`;
        }
        
        document.getElementById('lastUpdated').textContent = new Date(data.system?.timestamp).toLocaleString();
        
    } catch (error) {
        console.error('Error loading system stats:', error);
    }
}

// Show sections
function showSection(sectionId) {
    // Hide all sections
    document.querySelectorAll('.dashboard-section').forEach(section => {
        section.style.display = 'none';
    });
    
    // Show selected section
    document.getElementById(sectionId + 'Section').style.display = 'block';
    
    // Update sidebar active item
    document.querySelectorAll('.sidebar-menu li').forEach(item => {
        item.classList.remove('active');
    });
    
    document.querySelectorAll('.sidebar-menu li')[getSectionIndex(sectionId)]?.classList.add('active');
    
    // Load section-specific data
    switch (sectionId) {
        case 'overview':
            loadStats();
            break;
        case 'users':
            loadUsers();
            break;
        case 'system':
            loadSystemStats();
            break;
        case 'memory':
            updateMemoryStats();
            break;
    }
}

function getSectionIndex(sectionId) {
    const sections = ['overview', 'users', 'memory', 'rateLimits', 'system', 'tools'];
    return sections.indexOf(sectionId);
}

// Update memory statistics
async function updateMemoryStats() {
    try {
        const response = await fetch(`${apiBaseUrl}/api/admin?action=stats`, {
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to load memory stats');
        
        const data = await response.json();
        
        const memoryCount = data.memory?.count || 0;
        const memorySize = data.memory?.size || 0;
        
        document.getElementById('memoryFileCount').textContent = memoryCount;
        document.getElementById('memoryTotalSize').textContent = formatBytes(memorySize);
        document.getElementById('memoryAvgSize').textContent = memoryCount > 0 
            ? formatBytes(memorySize / memoryCount)
            : '0 KB';
        
        // Update progress bar (mock percentage)
        const percent = Math.min(Math.round(memorySize / (1024 * 1024) / 10), 100);
        document.getElementById('memoryBar').style.width = `${percent}%`;
        document.getElementById('memoryPercent').textContent = `${percent}%`;
        
    } catch (error) {
        console.error('Error updating memory stats:', error);
    }
}

// Clear user memory from tools
async function clearUserMemory() {
    const userId = document.getElementById('clearUserId').value.trim();
    if (!userId) {
        alert('Please enter a User ID');
        return;
    }
    
    await deleteUserMemory(userId);
    document.getElementById('clearUserId').value = '';
}

// Reset user rate limits
async function resetUserRateLimit() {
    const userId = document.getElementById('resetUserId').value.trim();
    if (!userId) {
        alert('Please enter a User ID');
        return;
    }
    
    alert('Rate limit reset functionality not implemented yet');
    // Implementation would require adding a new admin endpoint
    document.getElementById('resetUserId').value = '';
}

// Lookup user
async function lookupUser() {
    const userId = document.getElementById('lookupUserId').value.trim();
    if (!userId) {
        alert('Please enter a User ID');
        return;
    }
    
    await viewUserDetails(userId);
    document.getElementById('lookupUserId').value = '';
}

// Export data
async function exportData() {
    const userId = document.getElementById('exportUserId').value.trim();
    
    try {
        let data;
        
        if (userId) {
            // Export single user
            const response = await fetch(`${apiBaseUrl}/api/admin?action=user&userId=${encodeURIComponent(userId)}`, {
                headers: {
                    'Authorization': `Bearer ${adminToken}`
                }
            });
            
            if (!response.ok) throw new Error('Failed to export user data');
            data = await response.json();
            
        } else {
            // Export all users (simplified)
            const response = await fetch(`${apiBaseUrl}/api/admin?action=users&limit=1000`, {
                headers: {
                    'Authorization': `Bearer ${adminToken}`
                }
            });
            
            if (!response.ok) throw new Error('Failed to export user data');
            data = await response.json();
        }
        
        // Create and download JSON file
        const jsonString = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `maxmovies-export-${userId || 'all'}-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
    } catch (error) {
        console.error('Error exporting data:', error);
        alert(`Failed to export data: ${error.message}`);
    }
}

// Close modal
function closeModal() {
    document.getElementById('userModal').style.display = 'none';
}

// Utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showLoading() {
    // You can implement a loading spinner here
    console.log('Loading...');
}

function hideLoading() {
    // Hide loading spinner
    console.log('Loading complete');
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('userModal');
    if (event.target === modal) {
        closeModal();
    }
};
